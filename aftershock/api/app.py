"""The FastAPI app: the API under /api, and the web app everywhere else.

    aftershock serve
    (or: uvicorn aftershock.api.app:create_app --factory --reload)
    then open http://localhost:8000 (the app) or http://localhost:8000/api/docs (the API)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from aftershock.api.cache import GraphCache
from aftershock.api.models import make_session_factory
from aftershock.api.routers import analyses, repos, snapshots
from aftershock.api.settings import Settings
from aftershock.api.web import mount_ui

API = "/api"


def create_app(settings: Settings | None = None, redis_client=None) -> FastAPI:
    settings = settings or Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    if redis_client is None and settings.redis_url:
        import redis
        redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)

    app = FastAPI(
        title="Aftershock API",
        version="1.0.0",
        description="Scan a Python repo once, then ask what a change would affect.",
        docs_url=f"{API}/docs",
        redoc_url=f"{API}/redoc",
        openapi_url=f"{API}/openapi.json",
    )
    app.state.settings = settings
    app.state.session_factory = make_session_factory(settings.database_url)
    app.state.redis = redis_client
    app.state.cache = GraphCache(redis_client)

    # the built UI is served from this same server; this is only for Vite's dev
    # server when it is opened directly on port 5173 instead of through its proxy
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get(f"{API}/health", tags=["meta"])
    def health():
        return {"ok": True, "version": app.version,
                "queue": "redis" if redis_client is not None else "in-process",
                "database": "postgresql" if settings.database_url.startswith("postgresql") else "sqlite",
                "cache_hits": app.state.cache.hits}

    app.include_router(repos.router, prefix=API)
    app.include_router(snapshots.router, prefix=API)
    app.include_router(analyses.router, prefix=API)
    mount_ui(app, settings.ui_dir)       # last: it answers every address the API does not
    return app

