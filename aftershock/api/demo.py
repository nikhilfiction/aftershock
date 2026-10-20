"""Demo mode (AFTERSHOCK_DEMO=true): a public site that shows real reports straight away.

When the server starts with an empty database, the two example apps that ship
with Aftershock (examples/shop_api in Python, examples/shop_js in TypeScript)
become small git repositories with two branches:

  main      the example as it is
  feature   rounds prices differently and deletes a function a route still calls

Both branches of both repositories are then scanned, with their tests traced,
so a visitor can open a pull request report or ask about a function at once.

Free hosting often wipes files on restart; the demo simply rebuilds itself.
These examples are part of Aftershock, so running their tests is safe even
when ALLOW_TRACING is off for every repository a visitor adds.
"""

import logging
import shutil
import subprocess
import threading
from pathlib import Path

from sqlalchemy import select

from aftershock.api.models import Repository, Snapshot
from aftershock.api.settings import Settings

log = logging.getLogger("aftershock.demo")


def _drop_function(text: str, start: str) -> str:
    """Removes the block that starts with `start`, up to the next blank line or the end."""
    before, _, after = text.partition(start)
    rest = after.split("\n\n", 1)
    return before.rstrip("\n") + "\n" + ("\n\n" + rest[1] if len(rest) > 1 else "")


# (repository name, example folder, {file: change}) for the feature branch
EXAMPLES = [
    ("shop-api", "shop_api", {
        "app/services/pricing.py": lambda t: t.replace("), 2)", "), 1)"),
        "app/services/orders.py": lambda t: _drop_function(t, "def list_orders"),
    }),
    ("shop-js", "shop_js", {
        "src/services/pricing.ts": lambda t: t.replace("* 100) / 100", "* 10) / 10"),
        "src/services/orders.ts": lambda t: _drop_function(t, "export function listOrders"),
    }),
]
SKIP = shutil.ignore_patterns("node_modules", "__pycache__", ".pytest_cache", ".blast-trace.json",
                              ".aftershock-trace.json")


def demo_root(settings: Settings) -> Path:
    return settings.data_dir / "demo"


def is_demo_repo(repo: Repository, settings: Settings) -> bool:
    """A repository the demo made itself: its tests may run, and it can't be deleted."""
    if not settings.demo or repo.url.startswith("https://"):
        return False
    return Path(repo.url).resolve().is_relative_to(demo_root(settings).resolve())


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.name=Aftershock demo", "-c", "user.email=demo@aftershock.local", *args],
                   cwd=repo, check=True, capture_output=True)


def build_repo(source: Path, dest: Path, changes: dict) -> None:
    """The example as a git repo: `main` as it is, `feature` with the changes."""
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest, ignore=SKIP)
    _git(dest, "init", "-q", "-b", "main")
    _git(dest, "add", ".")
    _git(dest, "commit", "-qm", "The example app")
    _git(dest, "checkout", "-qb", "feature")
    for rel, change in changes.items():
        path = dest / rel
        path.write_text(change(path.read_text()))
    _git(dest, "commit", "-qam", "Round prices to one decimal; remove the old order listing")
    _git(dest, "checkout", "-q", "main")


def seed_demo(session_factory, settings: Settings, redis_client=None, wait: bool = False) -> list[int]:
    """Adds and scans the example repositories if the database has none yet.
    Returns the new snapshot ids. The scans run in the background unless `wait`."""
    from aftershock.api.scanning import run_scan

    with session_factory() as db:
        if db.scalar(select(Repository.id).limit(1)) is not None:
            return []
        ids = []
        for name, folder, changes in EXAMPLES:
            source = settings.examples_dir / folder
            if not source.is_dir():
                log.warning("demo: %s is missing, skipped", source)
                continue
            dest = demo_root(settings) / name
            build_repo(source, dest, changes)
            repo = Repository(name=name, url=str(dest.resolve()), default_branch="main")
            db.add(repo)
            db.flush()
            for ref in ("main", "feature"):
                snap = Snapshot(repo_id=repo.id, ref=ref, want_dynamic=True)
                db.add(snap)
                db.flush()
                ids.append(snap.id)
        db.commit()

    if redis_client is not None:
        for snapshot_id in ids:
            redis_client.rpush(settings.queue_name, snapshot_id)
        return ids

    def scan_all() -> None:
        for snapshot_id in ids:
            with session_factory() as db:
                run_scan(db, snapshot_id, settings)

    if wait:
        scan_all()
    else:
        threading.Thread(target=scan_all, name="demo-scans", daemon=True).start()
    return ids
