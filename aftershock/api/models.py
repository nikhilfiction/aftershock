"""Database tables (SQLAlchemy 2.0). Works on SQLite and PostgreSQL unchanged.

Every graph belongs to a snapshot (one commit of one repo), so old reports
can always be reproduced from the exact graph they were made with.
"""

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


def now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Repository(Base):
    __tablename__ = "repositories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    url: Mapped[str] = mapped_column(String(1000))          # https URL or a local folder
    subdir: Mapped[str] = mapped_column(String(500), default="")   # scan only this folder, e.g. "backend"
    default_branch: Mapped[str] = mapped_column(String(200), default="HEAD")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    snapshots: Mapped[list["Snapshot"]] = relationship(
        back_populates="repository", cascade="all, delete-orphan", order_by="Snapshot.id.desc()"
    )


class Snapshot(Base):
    """One analysis run of one commit."""
    __tablename__ = "snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    repo_id: Mapped[int] = mapped_column(ForeignKey("repositories.id", ondelete="CASCADE"), index=True)
    ref: Mapped[str] = mapped_column(String(200))                      # what the user asked for, e.g. "main"
    commit_sha: Mapped[str | None] = mapped_column(String(64))         # what it resolved to
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|scanning|tracing|ready|failed
    error: Mapped[str | None] = mapped_column(Text)
    want_dynamic: Mapped[bool] = mapped_column(Boolean, default=False)
    has_dynamic: Mapped[bool] = mapped_column(Boolean, default=False)
    symbol_count: Mapped[int] = mapped_column(Integer, default=0)
    edge_count: Mapped[int] = mapped_column(Integer, default=0)
    unresolved_calls: Mapped[list] = mapped_column(JSON, default=list)   # [[caller, candidate, line], ...]
    # {"languages": ["python", "typescript"], "test_runner": "vitest", "warnings": [...]}
    scan_meta: Mapped[dict | None] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    repository: Mapped[Repository] = relationship(back_populates="snapshots")


class SymbolRow(Base):
    """A graph node."""
    __tablename__ = "symbols"

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"))
    qualified_name: Mapped[str] = mapped_column(String(1000))
    kind: Mapped[str] = mapped_column(String(20))
    module: Mapped[str] = mapped_column(String(1000))
    file_path: Mapped[str] = mapped_column(String(1000))
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)
    is_test: Mapped[bool] = mapped_column(Boolean, default=False)
    route: Mapped[str | None] = mapped_column(String(500), default="")   # e.g. "GET /orders/"
    test_name: Mapped[str | None] = mapped_column(String(1000), default="")   # JS/TS tests: "orders lists mine"

    __table_args__ = (Index("ix_symbols_snapshot_name", "snapshot_id", "qualified_name"),)


class EdgeRow(Base):
    """A graph edge: `source` uses `target`. Stored by name, so rebuilding the
    graph needs no joins."""
    __tablename__ = "edges"

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(String(1000))
    target: Mapped[str] = mapped_column(String(1000))
    kind: Mapped[str] = mapped_column(String(20))           # calls | references | imports | inherits
    line: Mapped[int] = mapped_column(Integer, default=0)
    origin: Mapped[str] = mapped_column(String(10), default="static")   # static | dynamic
    call_count: Mapped[int] = mapped_column(Integer, default=1)

    # every blast radius query asks "who points at X?", so this index decides query speed
    __table_args__ = (Index("ix_edges_snapshot_target", "snapshot_id", "target"),)


class AnalysisRow(Base):
    """A saved blast radius report."""
    __tablename__ = "analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshots.id", ondelete="CASCADE"), index=True)
    targets: Mapped[list] = mapped_column(JSON, default=list)
    base: Mapped[str | None] = mapped_column(String(200))
    diff_text: Mapped[str | None] = mapped_column(Text)
    depth: Mapped[int] = mapped_column(Integer, default=3)
    risk_score: Mapped[int] = mapped_column(Integer)
    risk_level: Mapped[str] = mapped_column(String(10))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


def add_missing_columns(engine) -> list[str]:
    """create_all makes missing tables but never changes existing ones. A column
    added in a newer version (always nullable) is added here, so a database made
    by an older version keeps working. Returns what it added, e.g. ["symbols.route"]."""
    existing = inspect(engine)
    added = []
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not existing.has_table(table.name):
                continue
            have = {c["name"] for c in existing.get_columns(table.name)}
            for column in table.columns:
                if column.name in have or not column.nullable:
                    continue
                kind = column.type.compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN {column.name} {kind}'))
                added.append(f"{table.name}.{column.name}")
    return added


def make_session_factory(database_url: str) -> sessionmaker:
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
    engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
    try:
        Base.metadata.create_all(engine)
        add_missing_columns(engine)
    except Exception:
        # the API and the worker can start at the same moment and race to
        # create the tables; whoever loses just checks again
        Base.metadata.create_all(engine)
        add_missing_columns(engine)
    return sessionmaker(engine, expire_on_commit=False)
