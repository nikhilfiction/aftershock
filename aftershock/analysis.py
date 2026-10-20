"""Turns changed symbols into a blast radius report with a risk score.

Everything the CLI, the API and the GitHub Action print comes from the
`Analysis` object built here, so all three always agree.
"""

import math
import re
import shlex
from dataclasses import asdict, dataclass, field

import networkx as nx

from aftershock.diff import DeletedSymbol
from aftershock.graph import blast, reachable_from
from aftershock.scanner import ScanResult

TEST_DEPTH = 6        # how far a test may be from changed code and still count as covering it


@dataclass
class SymbolInfo:
    name: str
    kind: str
    file_path: str
    line: int
    distance: int = 0                     # 0 = this symbol itself changed
    via: list[str] = field(default_factory=list)
    reached_by_tests: bool = False
    confidence: str = "static"            # static | dynamic | both (dynamic arrives in Phase 4)
    route: str = ""                       # routes only, e.g. "GET /orders/"
    call_line: int = 0                    # line where this symbol calls the next one in `via` (0 = unknown)


@dataclass
class CallSite:
    caller: str
    file_path: str
    line: int


@dataclass
class DeletedInfo:
    name: str
    file_path: str
    still_called_by: list[str]
    call_sites: list[CallSite] = field(default_factory=list)   # where each caller still calls it

    def __post_init__(self):
        # rebuilt from a saved report, the call sites arrive as plain dicts
        self.call_sites = [c if isinstance(c, CallSite) else CallSite(**c) for c in self.call_sites]


@dataclass
class Risk:
    score: int                            # 0 to 100
    level: str                            # low | medium | high
    parts: dict[str, int]                 # how many points each factor added
    reasons: list[str]                    # the same thing in plain sentences


@dataclass
class Analysis:
    changed: list[SymbolInfo]
    affected: list[SymbolInfo]
    tests_to_run: list[str]               # e.g. tests/test_users.py::test_login, tests/shop.test.ts::orders lists mine
    deleted: list[DeletedInfo]
    hidden_dependencies: list[str]        # filled by dynamic tracing in Phase 4
    risk: Risk
    depth: int
    test_command: str = ""                # the command that runs just tests_to_run (one line per test runner)

    @property
    def routes(self) -> list[SymbolInfo]:
        return [s for s in self.changed + self.affected if s.kind == "route"]

    @property
    def untested(self) -> list[SymbolInfo]:
        return [s for s in self.changed if not s.reached_by_tests and s.kind not in ("module", "variable")]

    def to_dict(self) -> dict:
        data = asdict(self)
        data["summary"] = {
            "changed": len(self.changed),
            "direct": sum(1 for s in self.affected if s.distance == 1),
            "indirect": sum(1 for s in self.affected if s.distance > 1),
            "routes": len(self.routes),
            "untested": len(self.untested),
            "deleted_but_still_called": sum(1 for d in self.deleted if d.still_called_by),
        }
        return data


# ---------------------------------------------------------------- helpers

def is_test_function(graph: nx.DiGraph, name: str) -> bool:
    data = graph.nodes[name]
    if data.get("test_name"):                         # a JS/TS it("...") or test("...")
        return True
    return (data["is_test"] and data["kind"] in ("function", "method") and data["file_path"].endswith(".py")
            and name.split(".")[-1].startswith("test"))


def runnable_id(graph: nx.DiGraph, name: str) -> str:
    """app.tests.test_users.TestLogin.test_ok -> tests/test_users.py::TestLogin::test_ok
    A JS/TS test keeps its title: tests/shop.test.ts::orders lists only my orders"""
    data = graph.nodes[name]
    if data.get("test_name"):
        return f"{data['file_path']}::{data['test_name']}"
    local = name[len(data["module"]) + 1:]
    return f"{data['file_path']}::{local.replace('.', '::')}"


pytest_id = runnable_id      # the old name


JS_REGEX_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\/]")
JS_RUNNERS = {
    "vitest": "npx vitest run",
    "jest": "npx jest",
    "mocha": "npx mocha",
    "node": "node --test",
}


def command_for_tests(tests: list[str], runner: str = "") -> str:
    """One command per test runner that runs exactly these tests.

    pytest takes the ids as they are. Vitest and Jest take the files plus a
    pattern that matches the full test names (-t); Mocha uses --grep.
    """
    python = [t for t in tests if t.split("::")[0].endswith(".py")]
    js = [t for t in tests if t not in python]
    lines = []
    if python:
        lines.append("pytest " + " ".join(shlex.quote(t) for t in python))
    if js:
        files = sorted({t.split("::", 1)[0] for t in js})
        names = sorted({t.split("::", 1)[1] for t in js if "::" in t})
        pattern = "^(" + "|".join(JS_REGEX_SPECIAL.sub(r"\\\g<0>", n) for n in names) + ")$"
        base = JS_RUNNERS.get(runner, "npx vitest run" if not runner else runner)
        quoted = " ".join(shlex.quote(f) for f in files)
        if runner in ("vitest", "jest", ""):
            lines.append(f"{base} {quoted} -t {shlex.quote(pattern)}")
        elif runner == "mocha":
            lines.append(f"{base} {quoted} --grep {shlex.quote(pattern)}")
        else:
            lines.append(f"{base} {quoted}")
    return "\n".join(lines)


def info(graph: nx.DiGraph, name: str, distance: int = 0, via=None, covered=frozenset(),
         confidence: str = "static", call_lines: dict[tuple[str, str], int] | None = None) -> SymbolInfo:
    data = graph.nodes[name]
    via = via or []
    call_line = 0
    if len(via) > 1:
        nxt = via[1]
        if graph.has_edge(name, nxt):
            call_line = graph.edges[name, nxt].get("line", 0)
        elif call_lines:                   # the next one was deleted: the call no longer resolves
            call_line = call_lines.get((name, nxt), 0)
    return SymbolInfo(
        name=name,
        kind=data["kind"],
        file_path=data["file_path"],
        line=data["start_line"],
        distance=distance,
        via=via,
        reached_by_tests=name in covered,
        confidence=confidence,
        route=data.get("route", ""),
        call_line=call_line,
    )


def has_runtime_edges(graph: nx.DiGraph) -> bool:
    return any("dynamic" in d["origins"] for *_, d in graph.edges(data=True))


def only(graph: nx.DiGraph, origin: str) -> nx.DiGraph:
    """A read-only view of the graph keeping only edges with this origin."""
    return nx.subgraph_view(graph, filter_edge=lambda a, b: origin in graph.edges[a, b]["origins"])


def score_risk(changed: list[SymbolInfo], affected: list[SymbolInfo], deleted: list[DeletedInfo]) -> Risk:
    """Four factors, each with a ceiling, so one factor can never decide alone.

    spread   up to 40  how much code depends on the change (closer counts more)
    routes   up to 30  how many API routes end up running changed code
    untested up to 30  share of changed functions that no test reaches
    broken   up to 60  deleted functions that something still calls; one alone is
                      enough for 'high', because it is a guaranteed crash
    """
    weighted = sum(1 / s.distance for s in affected if s.kind != "module")
    routes = sum(1 for s in changed + affected if s.kind == "route")
    code = [s for s in changed if s.kind not in ("module", "variable")]
    untested = [s for s in code if not s.reached_by_tests]
    broken = [d for d in deleted if d.still_called_by]

    parts = {
        "spread": round(40 * (1 - math.exp(-weighted / 8))),
        "routes": round(30 * (1 - math.exp(-routes / 4))),
        "untested": round(30 * len(untested) / len(code)) if code else 0,
        "broken": min(60, 55 * len(broken)),
    }
    score = min(100, sum(parts.values()))
    level = "low" if score < 25 else "medium" if score < 55 else "high"

    reasons = []
    if affected:
        direct = sum(1 for s in affected if s.distance == 1)
        reasons.append(f"{len(affected)} symbols depend on this change ({direct} directly)")
    if routes:
        reasons.append(f"{routes} API route{'s run' if routes != 1 else ' runs'} the changed code")
    if untested:
        if len(code) == 1:
            reasons.append("the changed function is not reached by any test")
        else:
            reasons.append(f"{len(untested)} of {len(code)} changed functions are not reached by any test")
    for d in broken:
        n = len(d.still_called_by)
        reasons.append(f"{d.name} was deleted but {n} place{'s still call' if n != 1 else ' still calls'} it")
    hidden = [s for s in affected if s.confidence == "dynamic"]
    if hidden:
        reasons.append(f"{len(hidden)} of them {'were' if len(hidden) != 1 else 'was'} found only by running the tests"
                       " (invisible in the code)")
    if not reasons:
        reasons.append("nothing else depends on the changed code")
    return Risk(score=score, level=level, parts=parts, reasons=reasons)


# ---------------------------------------------------------------- the analysis

def analyze(
    graph: nx.DiGraph,
    targets: list[str],
    depth: int = 3,
    deleted: list[DeletedSymbol] = (),
    result: ScanResult | None = None,
) -> Analysis:
    """targets = changed symbols. result is only needed to find callers of deleted symbols."""
    targets = [t for t in dict.fromkeys(targets) if t in graph]
    test_names = [n for n in graph if is_test_function(graph, n)]
    covered = reachable_from(graph, test_names, TEST_DEPTH)

    distances, chains = blast(graph, targets, max(depth, TEST_DEPTH))

    # deleted symbols are gone from the graph, so find their callers from the
    # calls that no longer resolve, then treat those callers as distance 1
    deleted_info = []
    call_lines: dict[tuple[str, str], int] = {}       # (caller, deleted name) -> line of the call
    for d in deleted:
        sites = []
        if result is not None:
            sites = sorted({
                (u.caller, u.line) for u in result.unresolved_calls
                if (u.candidate == d.qualified_name or u.candidate.startswith(d.qualified_name + "."))
                and u.caller in graph
            })
        callers_ = sorted({caller for caller, _ in sites})
        for caller, line in sites:
            call_lines.setdefault((caller, d.qualified_name), line)
        deleted_info.append(DeletedInfo(
            d.qualified_name, d.file_path, callers_,
            [CallSite(caller, graph.nodes[caller]["file_path"], line) for caller, line in sites],
        ))

        broken_dist, broken_chains = blast(graph, callers_, max(depth, TEST_DEPTH) - 1)
        for c in callers_:
            broken_dist[c], broken_chains[c] = 0, [c]
        for node, dist in broken_dist.items():
            if node in targets:
                continue
            if dist + 1 < distances.get(node, math.inf):
                distances[node] = dist + 1
                chains[node] = broken_chains[node] + [d.qualified_name]

    # Confidence: is each affected symbol reachable through edges read from the
    # code, through edges seen at runtime, or both? Reachable only at runtime
    # means a hidden dependency that reading the code would never show.
    confidence: dict[str, str] = {}
    if has_runtime_edges(graph):
        static_reach = set(blast(only(graph, "static"), targets, depth)[0])
        static_reach |= {n for n in distances if chains.get(n, [""])[-1] in {d.qualified_name for d in deleted}}
        runtime_reach = set(blast(only(graph, "dynamic"), targets, depth)[0])
        for n in distances:
            confidence[n] = ("both" if n in static_reach and n in runtime_reach
                             else "static" if n in static_reach else "dynamic")

    changed = [info(graph, t, covered=covered) for t in targets if not graph.nodes[t]["is_test"]]
    affected = [
        info(graph, n, d, chains.get(n), covered, confidence.get(n, "static"), call_lines)
        for n, d in distances.items()
        if d <= depth and not graph.nodes[n]["is_test"]
    ]
    affected.sort(key=lambda s: (s.distance, s.kind != "route", s.name))

    tests = sorted(
        runnable_id(graph, n) for n, d in distances.items() if d <= TEST_DEPTH and is_test_function(graph, n)
    )
    # a changed test file: run the changed tests themselves too
    tests = sorted(set(tests) | {runnable_id(graph, t) for t in targets if is_test_function(graph, t)})

    hidden = [s.name for s in affected if s.confidence == "dynamic"]
    risk = score_risk(changed, affected, deleted_info)
    command = command_for_tests(tests, graph.graph.get("test_runner", ""))
    return Analysis(changed, affected, tests, deleted_info, hidden, risk, depth, command)
