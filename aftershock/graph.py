"""Builds the dependency graph and answers "who depends on this?"."""

from dataclasses import asdict

import networkx as nx

from aftershock.scanner import ScanResult


def build_graph(result: ScanResult) -> nx.DiGraph:
    """Nodes = symbols, edges point from caller to callee (A uses B)."""
    graph = nx.DiGraph()
    graph.graph.update(result.meta)          # e.g. the test runner, used for the test command
    for name, sym in result.symbols.items():
        graph.add_node(name, **asdict(sym))

    for edge in result.edges:
        if edge.source not in graph or edge.target not in graph:
            continue
        if graph.has_edge(edge.source, edge.target):
            # same pair seen again (called twice, or call + reference): keep one edge, count it
            data = graph.edges[edge.source, edge.target]
            data["count"] += edge.count
            data["kinds"].add(edge.kind)
            data["origins"].add(edge.origin)
            if not data["line"]:            # runtime edges from old trace files carry no line
                data["line"] = edge.line
        else:
            graph.add_edge(edge.source, edge.target, kinds={edge.kind}, count=edge.count,
                           line=edge.line, origins={edge.origin})
    return graph


def edge_confidence(data: dict) -> str:
    """static = only the code says so, dynamic = only seen at runtime, both = confirmed."""
    origins = data["origins"]
    return "both" if len(origins) > 1 else next(iter(origins))


def find_symbol(graph: nx.DiGraph, query: str) -> list[str]:
    """Exact name first, then anything ending in the query (e.g. 'login_user')."""
    if query in graph:
        return [query]
    return sorted(n for n in graph if n == query or n.endswith("." + query))


def callers(graph: nx.DiGraph, target: str, max_depth: int = 3) -> dict[str, int]:
    """Everything that depends on `target`, with its distance.

    Reverse the edges so arrows point from callee to caller, then BFS:
    distance 1 = direct callers, 2 = callers of callers, and so on.
    """
    reverse = graph.reverse(copy=False)
    distances = nx.single_source_shortest_path_length(reverse, target, cutoff=max_depth)
    distances.pop(target, None)
    return distances


def blast(graph: nx.DiGraph, targets: list[str], max_depth: int) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Same idea as `callers`, but starting from several changed symbols at once.

    Returns (distance per affected symbol, chain per affected symbol). Each
    chain reads from the affected symbol down to the changed one it reaches
    first, e.g. ["update_resume", "get_current_user_id", "decode_user_id"].
    """
    targets = [t for t in targets if t in graph]
    if not targets:
        return {}, {}
    reverse = graph.reverse(copy=False)
    distances, paths = nx.multi_source_dijkstra(reverse, set(targets), cutoff=max_depth)
    chains = {node: list(reversed(path)) for node, path in paths.items()}
    for t in targets:
        distances.pop(t, None)
        chains.pop(t, None)
    return {n: int(d) for n, d in distances.items()}, chains


def reachable_from(graph: nx.DiGraph, sources: list[str], max_depth: int) -> set[str]:
    """Everything the given symbols use, directly or indirectly (forward direction)."""
    found: set[str] = set()
    for source in sources:
        found.update(nx.single_source_shortest_path_length(graph, source, cutoff=max_depth))
    return found


def path_to(graph: nx.DiGraph, affected: str, target: str) -> list[str]:
    """One chain showing why `affected` depends on `target`."""
    try:
        return nx.shortest_path(graph, affected, target)
    except nx.NetworkXNoPath:
        return []
