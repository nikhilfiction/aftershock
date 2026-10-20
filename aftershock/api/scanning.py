"""Getting a repo's code onto disk, scanning it, and saving the graph.

For git repos we keep one bare "mirror" clone per repository and export each
requested commit into its own folder. Refetching a mirror is fast, and every
snapshot gets the exact files of its commit.
"""

import io
import re
import shutil
import subprocess
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from aftershock.api.models import EdgeRow, Repository, Snapshot, SymbolRow
from aftershock.api.settings import Settings
from aftershock.project import count_source_files, scan_project
from aftershock.scanner import Edge, ScanResult, Symbol, UnresolvedCall

SAFE_REF = re.compile(r"^[A-Za-z0-9._/^~@{}-]{1,200}$")


class ScanError(Exception):
    pass


# ---------------------------------------------------------------- validation

def check_url(url: str, settings: Settings) -> None:
    """Only https git URLs, or local folders when allowed. Blocks git's
    `ext::` and similar transports, which can run commands."""
    if url.startswith("https://"):
        return
    if settings.allow_local_paths and Path(url).expanduser().is_dir():
        return
    allowed = "an https:// git URL" + (" or a folder on this machine" if settings.allow_local_paths else "")
    raise ScanError(f"Repository must be {allowed}")


def check_ref(ref: str) -> str:
    if not SAFE_REF.match(ref) or ref.startswith("-") or ".." in ref:
        raise ScanError(f"Not a valid git ref: {ref!r}")
    return ref


def check_subdir(subdir: str) -> str:
    subdir = subdir.strip("/")
    if subdir and (".." in Path(subdir).parts or Path(subdir).is_absolute()):
        raise ScanError("subdir must be a path inside the repository")
    return subdir


# ---------------------------------------------------------------- git

def _git(*args: str, cwd: Path | None = None, binary: bool = False) -> str | bytes:
    cmd = ["git", "-c", "protocol.ext.allow=never", *args]
    try:
        out = subprocess.run(cmd, cwd=cwd, capture_output=True, check=True, timeout=600)
    except subprocess.CalledProcessError as exc:
        raise ScanError(exc.stderr.decode(errors="replace").strip() or "git failed")
    except subprocess.TimeoutExpired:
        raise ScanError("git took longer than 10 minutes")
    return out.stdout if binary else out.stdout.decode().strip()


def is_git_repo(path: Path) -> bool:
    """True only for the top folder of a git repo. A folder *inside* a repo
    (like examples/shop_api in this project) is scanned as a plain folder."""
    try:
        top = _git("-C", str(path), "rev-parse", "--show-toplevel")
    except ScanError:
        return False
    return Path(top).resolve() == path.resolve()


def mirror_path(settings: Settings, repo_id: int) -> Path:
    return settings.data_dir / "repos" / f"{repo_id}.git"


def snapshot_path(settings: Settings, snapshot_id: int) -> Path:
    return settings.data_dir / "snapshots" / str(snapshot_id)


def scan_root_of(snap: Snapshot, settings: Settings) -> Path:
    """The folder a snapshot's file paths are relative to. For a plain folder
    that is the folder itself, as it is now; git snapshots keep their own copy."""
    repo = snap.repository
    if snap.commit_sha == "working-tree":
        base = Path(repo.url).expanduser()
    else:
        base = snapshot_path(settings, snap.id)
    return base / check_subdir(repo.subdir) if repo.subdir else base


def update_mirror(repo: Repository, settings: Settings) -> Path:
    mirror = mirror_path(settings, repo.id)
    source = str(Path(repo.url).expanduser().resolve()) if not repo.url.startswith("https://") else repo.url
    if mirror.exists():
        _git("-C", str(mirror), "remote", "update", "--prune")
    else:
        mirror.parent.mkdir(parents=True, exist_ok=True)
        _git("clone", "--mirror", "--", source, str(mirror))
    return mirror


def export_commit(mirror: Path, sha: str, dest: Path) -> None:
    """Writes the files of one commit into `dest` (like a checkout, without .git)."""
    archive = _git("-C", str(mirror), "archive", "--format=tar", sha, binary=True)
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(dest, filter="data")     # "data" refuses absolute paths and ../ tricks


def prepare_source(repo: Repository, snap: Snapshot, settings: Settings) -> tuple[Path, str]:
    """Returns (folder to scan, commit sha)."""
    local = Path(repo.url).expanduser()
    if not repo.url.startswith("https://") and not is_git_repo(local):
        # a plain folder: scan it where it is
        return local.resolve(), "working-tree"

    mirror = update_mirror(repo, settings)
    sha = _git("-C", str(mirror), "rev-parse", "--verify", f"{check_ref(snap.ref)}^{{commit}}")
    dest = snapshot_path(settings, snap.id)
    export_commit(mirror, sha, dest)
    return dest, sha


# ---------------------------------------------------------------- scan + save

def save_result(db: Session, snap: Snapshot, result: ScanResult) -> None:
    db.execute(delete(SymbolRow).where(SymbolRow.snapshot_id == snap.id))
    db.execute(delete(EdgeRow).where(EdgeRow.snapshot_id == snap.id, EdgeRow.origin == "static"))
    db.add_all(
        SymbolRow(snapshot_id=snap.id, qualified_name=s.qualified_name, kind=s.kind, module=s.module,
                  file_path=s.file_path, start_line=s.start_line, end_line=s.end_line, is_test=s.is_test,
                  route=s.route, test_name=s.test_name)
        for s in result.symbols.values()
    )
    db.add_all(
        EdgeRow(snapshot_id=snap.id, source=e.source, target=e.target, kind=e.kind, line=e.line, origin="static")
        for e in result.edges
    )
    snap.unresolved_calls = [[u.caller, u.candidate, u.line] for u in result.unresolved_calls]
    snap.scan_meta = result.meta
    snap.symbol_count = len(result.symbols)
    # links, not rows: a function calling another twice is still one link
    snap.edge_count = len({(e.source, e.target) for e in result.edges})


def run_scan(db: Session, snapshot_id: int, settings: Settings) -> None:
    """The background job. Never raises: failures are stored on the snapshot."""
    snap = db.get(Snapshot, snapshot_id)
    if snap is None:
        return
    try:
        snap.status = "scanning"
        db.commit()

        root, sha = prepare_source(snap.repository, snap, settings)
        scan_root = root / check_subdir(snap.repository.subdir) if snap.repository.subdir else root
        if not scan_root.is_dir():
            raise ScanError(f"Folder {snap.repository.subdir!r} does not exist in this commit")
        files = count_source_files(scan_root)
        if files > settings.max_repo_files:
            raise ScanError(f"{files} code files is above the limit of {settings.max_repo_files}")
        if files == 0:
            raise ScanError("No Python, JavaScript or TypeScript files found")

        result = scan_project(scan_root)
        snap.commit_sha = sha
        snap.error = None
        save_result(db, snap, result)

        if snap.want_dynamic:
            snap.status = "tracing"
            db.commit()
            from aftershock.api.tracing_job import run_trace
            run_trace(db, snap, scan_root, settings)
        warnings = (result.meta or {}).get("warnings") or []
        if warnings:
            snap.error = " ".join([*warnings, snap.error or ""]).strip()

        snap.status = "ready"          # error may still hold a tracing warning
        snap.scanned_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:              # noqa: BLE001 - store any failure for the user to see
        db.rollback()
        snap = db.get(Snapshot, snapshot_id)
        snap.status = "failed"
        snap.error = str(exc)[:2000]
        db.commit()


# ---------------------------------------------------------------- load back

def load_result(db: Session, snapshot_id: int) -> ScanResult:
    """Rebuilds the ScanResult the scanner produced, from the database."""
    result = ScanResult()
    for row in db.scalars(select(SymbolRow).where(SymbolRow.snapshot_id == snapshot_id)):
        result.symbols[row.qualified_name] = Symbol(
            row.qualified_name, row.kind, row.file_path, row.start_line, row.end_line, row.is_test, row.module,
            row.route or "", row.test_name or "",
        )
    for row in db.scalars(select(EdgeRow).where(EdgeRow.snapshot_id == snapshot_id)):
        result.edges.append(Edge(row.source, row.target, row.kind, row.line, row.origin, row.call_count))
    snap = db.get(Snapshot, snapshot_id)
    result.unresolved_calls = [UnresolvedCall(c, cand, line) for c, cand, line in (snap.unresolved_calls or [])]
    # a scan made before JavaScript support read Python only
    result.meta = snap.scan_meta if snap.scan_meta is not None else {"languages": ["python"], "test_runner": ""}
    return result
