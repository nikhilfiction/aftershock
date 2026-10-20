from pathlib import PurePosixPath

import networkx as nx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from aftershock.analysis import analyze, is_test_function
from aftershock.api.cache import GraphCache
from aftershock.api.deps import field_error, get_cache, get_db, get_ready_snapshot, get_settings, get_snapshot
from aftershock.api.models import AnalysisRow, Snapshot
from aftershock.api.scanning import ScanError, check_ref, mirror_path, scan_root_of
from aftershock.api.schemas import (AnalysisOut, BlastRequest, GraphEdge, GraphNode, GraphOut, SnapshotOut,
                                      SnapshotStats, SourceOut, SymbolOut)
from aftershock.api.settings import Settings
from aftershock.diff import DiffError, changes_between, changes_from_text, is_source_path
from aftershock.graph import edge_confidence, find_symbol

router = APIRouter(prefix="/snapshots", tags=["snapshots"])

MAX_GRAPH_NODES = 300
MAX_SOURCE_LINES = 200


@router.get("/{snapshot_id}", response_model=SnapshotOut)
def snapshot_status(snap: Snapshot = Depends(get_snapshot)):
    return snap


@router.get("/{snapshot_id}/symbols", response_model=list[SymbolOut])
def search_symbols(
    q: str = Query("", description="part of a name, e.g. 'auth' or 'login'"),
    kind: str | None = None,
    include_tests: bool = False,
    limit: int = Query(50, ge=1, le=500),
    snap: Snapshot = Depends(get_ready_snapshot),
    db: Session = Depends(get_db),
    cache: GraphCache = Depends(get_cache),
):
    _, graph = cache.get(db, snap.id)
    needle = q.lower()
    found = []
    for name, data in graph.nodes(data=True):
        if needle not in name.lower() or (kind and data["kind"] != kind) or (data["is_test"] and not include_tests):
            continue
        found.append(SymbolOut(name=name, kind=data["kind"], file_path=data["file_path"],
                               line=data["start_line"], is_test=data["is_test"], route=data.get("route", "")))
    # exact short-name matches first, then shorter names
    found.sort(key=lambda s: (s.name.split(".")[-1].lower() != needle, len(s.name), s.name))
    return found[:limit]


@router.get("/{snapshot_id}/stats", response_model=SnapshotStats)
def snapshot_stats(
    snap: Snapshot = Depends(get_ready_snapshot),
    db: Session = Depends(get_db),
    cache: GraphCache = Depends(get_cache),
):
    """Counts for a scan: how many files, routes and tests, and how many links
    the tests confirmed or found that reading the code missed."""
    result, graph = cache.get(db, snap.id)
    origins = [d["origins"] for *_, d in graph.edges(data=True)]
    nodes = graph.nodes(data=True)
    return SnapshotStats(
        languages=graph.graph.get("languages", []),
        test_runner=graph.graph.get("test_runner", ""),
        symbols=graph.number_of_nodes(),
        links=graph.number_of_edges(),
        files=sum(1 for _, d in nodes if d["kind"] == "module"),
        routes=sum(1 for _, d in nodes if d["kind"] == "route" and not d["is_test"]),
        tests=sum(1 for n in graph if is_test_function(graph, n)),
        read_from_code=sum(1 for o in origins if "static" in o),
        seen_running=sum(1 for o in origins if "dynamic" in o),
        confirmed=sum(1 for o in origins if len(o) > 1),
        runtime_only=sum(1 for o in origins if o == {"dynamic"}),
        unresolved_calls=result.unresolved,
    )


@router.get("/{snapshot_id}/source", response_model=SourceOut)
def source_lines(
    path: str = Query(description="a file path as the scan reports it, e.g. app/services/hooks.py or src/app.ts"),
    start: int = Query(1, ge=1),
    end: int | None = Query(None, ge=1, description=f"last line to return; at most {MAX_SOURCE_LINES} lines"),
    snap: Snapshot = Depends(get_ready_snapshot),
    settings: Settings = Depends(get_settings),
):
    """A few lines of one scanned file, for showing code next to the report.
    Git scans read the exact commit; a plain folder is read as it is now."""
    rel = PurePosixPath(path)
    if rel.is_absolute() or ".." in rel.parts or not is_source_path(path):
        raise HTTPException(400, "path must be a code file inside the scanned folder")
    end = end or start
    if end < start:
        raise HTTPException(400, "end must not be before start")
    end = min(end, start + MAX_SOURCE_LINES - 1)

    root = scan_root_of(snap, settings).resolve()
    file = (root / rel).resolve()
    if not file.is_relative_to(root):
        raise HTTPException(400, "path must be a code file inside the scanned folder")
    if not file.is_file():
        raise HTTPException(404, f"{path} is not on disk any more")
    lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
    return SourceOut(path=path, start=start, lines=lines[start - 1:end])


@router.post("/{snapshot_id}/blast-radius", response_model=AnalysisOut)
def blast_radius(
    body: BlastRequest,
    snap: Snapshot = Depends(get_ready_snapshot),
    db: Session = Depends(get_db),
    cache: GraphCache = Depends(get_cache),
    settings: Settings = Depends(get_settings),
):
    result, graph = cache.get(db, snap.id)
    prefix = f"{snap.repository.subdir}/" if snap.repository.subdir else ""
    deleted = []

    if body.targets:
        targets = []
        for query in body.targets:
            matches = find_symbol(graph, query)
            if not matches:
                raise HTTPException(404, f"No symbol matches {query!r}")
            if len(matches) > 1:
                raise HTTPException(400, f"{query!r} is ambiguous: {matches[:10]}")
            targets.append(matches[0])
    elif body.diff:
        changes = changes_from_text(body.diff, result, prefix)
        targets, deleted = changes.changed, changes.deleted
    else:
        mirror = mirror_path(settings, snap.repo_id)
        if not mirror.exists() or snap.commit_sha in (None, "working-tree"):
            raise field_error("base", "This snapshot is a plain folder with no git history; paste a diff instead")
        try:
            changes = changes_between(mirror, check_ref(body.base), snap.commit_sha, result, prefix)
        except (ScanError, DiffError) as exc:
            raise field_error("base", str(exc))
        targets, deleted = changes.changed, changes.deleted

    analysis = analyze(graph, targets, body.depth, deleted, result)
    report = analysis.to_dict()
    row = AnalysisRow(
        snapshot_id=snap.id, targets=targets, base=body.base, diff_text=body.diff, depth=body.depth,
        risk_score=analysis.risk.score, risk_level=analysis.risk.level, result=report,
    )
    db.add(row)
    db.commit()
    return AnalysisOut(id=row.id, snapshot_id=snap.id, risk_score=row.risk_score, risk_level=row.risk_level,
                       created_at=row.created_at, report=report)


@router.get("/{snapshot_id}/graph", response_model=GraphOut)
def graph_view(
    focus: str | None = Query(None, description="a symbol to center on; without it you get the module graph"),
    depth: int = Query(2, ge=1, le=5),
    include_tests: bool = False,
    snap: Snapshot = Depends(get_ready_snapshot),
    db: Session = Depends(get_db),
    cache: GraphCache = Depends(get_cache),
):
    """Nodes and edges for the UI to draw."""
    _, graph = cache.get(db, snap.id)

    if focus:
        matches = find_symbol(graph, focus)
        if len(matches) != 1:
            raise HTTPException(404 if not matches else 400, f"{focus!r} matched {len(matches)} symbols")
        focus = matches[0]
        # callers AND callees around the focus, up to `depth` steps either way
        nodes = set(nx.single_source_shortest_path_length(graph.reverse(copy=False), focus, cutoff=depth))
        nodes |= set(nx.single_source_shortest_path_length(graph, focus, cutoff=depth))
    else:
        nodes = {n for n, d in graph.nodes(data=True) if d["kind"] == "module"}

    if not include_tests:
        nodes = {n for n in nodes if not graph.nodes[n]["is_test"] or n == focus}
    truncated = len(nodes) > MAX_GRAPH_NODES
    if truncated:
        # keep the nodes closest to the focus
        order = nx.single_source_shortest_path_length(graph.to_undirected(as_view=True), focus) if focus else {}
        nodes = set(sorted(nodes, key=lambda n: (order.get(n, 99), n))[:MAX_GRAPH_NODES])

    sub = graph.subgraph(nodes)
    return GraphOut(
        focus=focus,
        nodes=[GraphNode(id=n, kind=d["kind"], file_path=d["file_path"], line=d["start_line"], is_test=d["is_test"],
                         route=d.get("route", ""))
               for n, d in sorted(sub.nodes(data=True))],
        edges=[GraphEdge(source=a, target=b, kinds=sorted(d["kinds"]), confidence=edge_confidence(d),
                         line=d.get("line", 0))
               for a, b, d in sub.edges(data=True)],
        truncated=truncated,
    )
