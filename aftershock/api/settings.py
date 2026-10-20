"""All configuration comes from environment variables, with defaults that
work on a laptop with nothing else installed.

    DATABASE_URL         sqlite:///./aftershock.db  (or postgresql+psycopg://user:pass@host/db)
    REDIS_URL            empty = run scans inside the API process; set = send them to the worker
    DATA_DIR             ./.aftershock-data  where repo clones and checkouts live
    ALLOW_LOCAL_PATHS    true = repos may be folders on this machine (turn off on a public server)
    MAX_REPO_FILES       refuse to scan repos with more code files (Python, JS, TS) than this
    ALLOW_TRACING        true = scans may run the repo's tests to record runtime calls.
                         That executes the repo's code: keep it off for repos you don't trust.
    TRACE_TIMEOUT        seconds before a traced test run is stopped
    UI_DIR               the built web app to serve at / (default: aftershock/web,
                         where `npm run build` in ui/ puts it)
    AFTERSHOCK_DEMO      true = a public demo: on startup with an empty database, the example
                         apps become git repos with two branches and get scanned (see api/demo.py)
    AFTERSHOCK_EXAMPLES  where the example apps are (default: examples/ next to the package)
"""

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "sqlite:///./aftershock.db"))
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", ""))
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("DATA_DIR", "./.aftershock-data")).resolve())
    allow_local_paths: bool = field(default_factory=lambda: _bool("ALLOW_LOCAL_PATHS", True))
    max_repo_files: int = field(default_factory=lambda: int(os.getenv("MAX_REPO_FILES", "20000")))
    allow_tracing: bool = field(default_factory=lambda: _bool("ALLOW_TRACING", True))
    trace_timeout: int = field(default_factory=lambda: int(os.getenv("TRACE_TIMEOUT", "900")))
    ui_dir: Path = field(default_factory=lambda: Path(os.getenv("UI_DIR") or Path(__file__).resolve().parent.parent / "web"))
    demo: bool = field(default_factory=lambda: _bool("AFTERSHOCK_DEMO", False))
    examples_dir: Path = field(default_factory=lambda: Path(
        os.getenv("AFTERSHOCK_EXAMPLES") or Path(__file__).resolve().parent.parent.parent / "examples"))
    queue_name: str = "aftershock:scans"
