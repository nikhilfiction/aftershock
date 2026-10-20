from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from aftershock.api.deps import field_error, get_db, get_repo, get_settings
from aftershock.api.jobs import enqueue_scan
from aftershock.api.models import Repository, Snapshot
from aftershock.api.scanning import ScanError, check_ref, check_subdir, check_url
from aftershock.api.schemas import RepoCreate, RepoDetail, RepoOut, ScanQueued, ScanRequest
from aftershock.api.settings import Settings

router = APIRouter(prefix="/repos", tags=["repositories"])


@router.post("", response_model=RepoOut, status_code=status.HTTP_201_CREATED)
def create_repo(body: RepoCreate, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    for field, check in (("url", lambda: check_url(body.url, settings)),
                         ("subdir", lambda: check_subdir(body.subdir)),
                         ("default_branch", lambda: check_ref(body.default_branch))):
        try:
            check()
        except ScanError as exc:
            raise field_error(field, str(exc))
    subdir = check_subdir(body.subdir)

    url = body.url if body.url.startswith("https://") else str(Path(body.url).expanduser().resolve())
    name = body.name or url.rstrip("/").split("/")[-1].removesuffix(".git")
    repo = Repository(name=name, url=url, subdir=subdir, default_branch=body.default_branch)
    db.add(repo)
    db.commit()
    return repo


@router.get("", response_model=list[RepoDetail])
def list_repos(db: Session = Depends(get_db)):
    """Every repository with its scans (newest first), so a list can show their state."""
    query = select(Repository).options(selectinload(Repository.snapshots)).order_by(Repository.id.desc())
    return db.scalars(query).all()


@router.get("/{repo_id}", response_model=RepoDetail)
def repo_detail(repo: Repository = Depends(get_repo)):
    return repo


@router.delete("/{repo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_repo(repo: Repository = Depends(get_repo), db: Session = Depends(get_db)):
    db.delete(repo)
    db.commit()


@router.post("/{repo_id}/scan", response_model=ScanQueued, status_code=status.HTTP_202_ACCEPTED)
def start_scan(
    request: Request,
    background: BackgroundTasks,
    body: ScanRequest = ScanRequest(),
    repo: Repository = Depends(get_repo),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    """Returns immediately with a queued snapshot; poll GET /snapshots/{id} until it is ready."""
    ref = body.ref or repo.default_branch
    try:
        check_ref(ref)
    except ScanError as exc:
        raise field_error("ref", str(exc))

    snap = Snapshot(repo_id=repo.id, ref=ref, want_dynamic=body.dynamic)
    db.add(snap)
    db.commit()
    queue = enqueue_scan(snap.id, settings, request.app.state.session_factory, request.app.state.redis, background)
    return ScanQueued(snapshot=snap, queue=queue)
