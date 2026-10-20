"""The tracing step of a scan: run the repo's tests with the tracer, then save
the runtime calls as `dynamic` edges next to the static ones.

This executes the repo's code (and, for JavaScript projects without
node_modules, its package install). Only enable it (ALLOW_TRACING=true) for
repos you trust, or inside a throwaway container with no network.
"""

from pathlib import Path

from sqlalchemy import delete
from sqlalchemy.orm import Session

from aftershock.api.models import EdgeRow, Snapshot, SymbolRow
from aftershock.api.settings import Settings
from aftershock.project import trace_project
from aftershock.tracing import trace_edges


def run_trace(db: Session, snap: Snapshot, scan_root: Path, settings: Settings) -> None:
    """Never fails the scan: if tracing goes wrong, the static graph is still
    saved and the reason is shown in snapshot.error."""
    from aftershock.api.demo import is_demo_repo

    if not settings.allow_tracing and not is_demo_repo(snap.repository, settings):
        snap.error = "Tracing is turned off on this server (ALLOW_TRACING=false); static results only."
        return

    out = settings.data_dir / "traces" / f"{snap.id}.json"
    outcome = trace_project(scan_root, out, timeout=settings.trace_timeout)
    trace = outcome.trace
    if trace is None:
        snap.error = " ".join(outcome.problems) or "The tests could not run, so there is no runtime data."
        return

    known = {row.qualified_name for row in db.query(SymbolRow.qualified_name).filter_by(snapshot_id=snap.id)}
    db.execute(delete(EdgeRow).where(EdgeRow.snapshot_id == snap.id, EdgeRow.origin == "dynamic"))
    rows = []
    for a, b, n, line in trace_edges(trace):
        # the scanner records `Repo()` as a use of the class Repo; the tracer sees Repo.__init__ run
        if b.endswith(".__init__") and b[: -len(".__init__")] in known:
            b = b[: -len(".__init__")]
        if a != b and a in known and b in known:
            rows.append(EdgeRow(snapshot_id=snap.id, source=a, target=b, kind="calls", line=line,
                                origin="dynamic", call_count=n))
    db.add_all(rows)
    snap.has_dynamic = True
    static = {(r.source, r.target) for r in db.query(EdgeRow).filter_by(snapshot_id=snap.id, origin="static")}
    snap.edge_count = len(static | {(r.source, r.target) for r in rows})
    notes = list(outcome.problems)
    if trace.get("tests_failed"):
        notes.append(f"{trace['tests_failed']} of {trace['tests_run']} tests failed; runtime data may be incomplete.")
    snap.error = " ".join(notes) or None
