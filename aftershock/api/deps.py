"""Shared things routes ask for with Depends(...). They all live on app.state,
which create_app fills in once at startup."""

from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from aftershock.api.cache import GraphCache
from aftershock.api.models import Repository, Snapshot
from aftershock.api.settings import Settings


def field_error(field: str, message: str) -> HTTPException:
    """Same shape FastAPI uses for its own validation errors, so a client can
    show every 422 next to the field named in `loc`."""
    return HTTPException(422, detail=[{"loc": ["body", field], "msg": message, "type": "value_error"}])


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as db:
        yield db


def get_cache(request: Request) -> GraphCache:
    return request.app.state.cache


def get_repo(repo_id: int, db: Session = Depends(get_db)) -> Repository:
    repo = db.get(Repository, repo_id)
    if repo is None:
        raise HTTPException(404, f"Repository {repo_id} not found")
    return repo


def get_snapshot(snapshot_id: int, db: Session = Depends(get_db)) -> Snapshot:
    snap = db.get(Snapshot, snapshot_id)
    if snap is None:
        raise HTTPException(404, f"Snapshot {snapshot_id} not found")
    return snap


def get_ready_snapshot(snap: Snapshot = Depends(get_snapshot)) -> Snapshot:
    if snap.status != "ready":
        detail = f"Snapshot {snap.id} is {snap.status}"
        if snap.error:
            detail += f": {snap.error}"
        raise HTTPException(409, detail)
    return snap
