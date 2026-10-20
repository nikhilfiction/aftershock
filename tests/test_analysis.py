"""The report: affected symbols, tests to run, coverage and the risk score."""

from aftershock.analysis import SymbolInfo, analyze, score_risk
from aftershock.render import to_json, to_markdown, to_text
from tests.test_scanner import make_repo

APP = {
    "app/core.py": """
        def helper(): pass
        def service(): helper()
        def lonely(): pass
    """,
    "app/routes.py": """
        from app.core import service
        router = object()

        @router.get("/x")
        def endpoint(): service()
    """,
    "tests/test_core.py": """
        from app.core import service
        def test_service(): service()
    """,
}


def test_affected_routes_and_tests(tmp_path):
    g = make_repo(tmp_path, APP)
    a = analyze(g, ["app.core.helper"])
    assert [(s.name, s.distance) for s in a.affected] == [
        ("app.core.service", 1),
        ("app.routes.endpoint", 2),
    ]
    assert a.affected[1].via == ["app.routes.endpoint", "app.core.service", "app.core.helper"]
    assert [s.name for s in a.routes] == ["app.routes.endpoint"]
    assert a.tests_to_run == ["tests/test_core.py::test_service"]
    assert a.changed[0].reached_by_tests


def test_untested_change_is_flagged(tmp_path):
    g = make_repo(tmp_path, APP)
    a = analyze(g, ["app.core.lonely"])
    assert [s.name for s in a.untested] == ["app.core.lonely"]
    assert a.risk.parts["untested"] == 30


def test_test_symbols_are_not_listed_as_affected(tmp_path):
    g = make_repo(tmp_path, APP)
    a = analyze(g, ["app.core.service"])
    assert all(not s.file_path.startswith("tests/") for s in a.affected)


def test_risk_score_has_ceilings():
    many = [SymbolInfo(f"m.f{i}", "route", "m.py", 1, distance=1) for i in range(500)]
    risk = score_risk([SymbolInfo("m.x", "function", "m.py", 1)], many, [])
    assert risk.parts["spread"] <= 40 and risk.parts["routes"] <= 30
    assert risk.score <= 100 and risk.level == "high"


def test_no_dependents_is_low_risk():
    risk = score_risk([SymbolInfo("m.x", "function", "m.py", 1, reached_by_tests=True)], [], [])
    assert risk.score == 0 and risk.level == "low"


def test_all_renderers_run(tmp_path):
    g = make_repo(tmp_path, APP)
    a = analyze(g, ["app.core.helper"])
    assert "Blast radius" in to_text(a)
    assert to_markdown(a).startswith("### ")
    assert '"summary"' in to_json(a)


def test_call_lines_and_where_a_deleted_function_is_still_called(tmp_path):
    from aftershock.diff import DeletedSymbol
    from textwrap import dedent

    from aftershock.graph import build_graph
    from aftershock.scanner import Scanner
    for rel, code in {
        "app/svc.py": """
            def total(): return 1
            def order():
                x = 1
                return total()
        """,
        "app/api.py": """
            from app import svc
            def view():
                return svc.order()
            def old_view():
                return svc.gone()
        """,
    }.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(dedent(code))
    result = Scanner(tmp_path).scan()
    graph = build_graph(result)
    a = analyze(graph, ["app.svc.total"], 3, [DeletedSymbol("app.svc.gone", "app/svc.py")], result)
    lines = {s.name: s.call_line for s in a.affected}
    assert lines["app.svc.order"] == 5           # `return total()`
    assert lines["app.api.view"] == 4            # `return svc.order()`
    assert lines["app.api.old_view"] == 6        # still calls the deleted function here
    site = a.deleted[0].call_sites[0]
    assert (site.caller, site.file_path, site.line) == ("app.api.old_view", "app/api.py", 6)

    # a saved report round-trips through plain dicts
    from aftershock.api.routers.analyses import analysis_from_report
    again = analysis_from_report(a.to_dict())
    assert again.deleted[0].call_sites[0].line == 6
