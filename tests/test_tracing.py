"""The tracer: runtime calls, framework frames in between, and merging with static edges."""

import shutil
import subprocess
import sys
from pathlib import Path
from textwrap import dedent

from aftershock.analysis import analyze
from aftershock.cli import main
from aftershock.graph import build_graph
from aftershock.scanner import Scanner
from aftershock.tracing import Tracer, load_trace, merge_trace, run_traced_tests

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "shop_api"


def write(root: Path, files: dict[str, str]) -> None:
    for rel, code in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(dedent(code))


def run_in_subprocess(root: Path, code: str) -> dict:
    """Traces `code` in a fresh interpreter so the test's own process stays clean."""
    script = dedent(f"""
        import json, sys
        sys.path.insert(0, {str(root)!r})
        from aftershock.tracing import Tracer
        t = Tracer({str(root)!r})
        t.start()
        {code}
        t.stop()
        print(json.dumps(t.to_dict()))
    """)
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True)
    return {(a, b): n for a, b, n, *_ in __import__("json").loads(out.stdout)["edges"]}


def trace_lines(root: Path, code: str) -> dict:
    script = dedent(f"""
        import json, sys
        sys.path.insert(0, {str(root)!r})
        from aftershock.tracing import Tracer
        t = Tracer({str(root)!r})
        t.start()
        {code}
        t.stop()
        print(json.dumps(t.to_dict()))
    """)
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, check=True)
    return {(a, b): line for a, b, _, line in __import__("json").loads(out.stdout)["edges"]}


def test_records_call_made_by_name(tmp_path):
    write(tmp_path, {"pkg/__init__.py": "", "pkg/hooks.py": """
        def target(): pass
        def dispatch(name): globals()[name]()
    """})
    edges = run_in_subprocess(tmp_path, "from pkg.hooks import dispatch; dispatch('target'); dispatch('target')")
    assert edges[("pkg.hooks.dispatch", "pkg.hooks.target")] == 2


def test_records_the_line_of_the_call(tmp_path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg/__init__.py").write_text("")
    (tmp_path / "pkg/hooks.py").write_text(
        "def target(): pass\n"
        "\n"
        "def dispatch(name):\n"
        "    hook = globals()[name]\n"
        "    hook()\n"
    )
    lines = trace_lines(tmp_path, "from pkg.hooks import dispatch; dispatch('target')")
    assert lines[("pkg.hooks.dispatch", "pkg.hooks.target")] == 5


def test_old_trace_files_without_lines_still_merge():
    from aftershock.scanner import ScanResult, Symbol
    from aftershock.tracing import merge_trace
    result = ScanResult()
    for name in ("m.a", "m.b"):
        result.symbols[name] = Symbol(name, "function", "m.py", 1, 2, False, "m")
    assert merge_trace(result, {"version": 1, "edges": [["m.a", "m.b", 3]]}) == 1
    assert (result.edges[0].line, result.edges[0].count) == (0, 3)


def test_library_frames_in_between_are_skipped(tmp_path):
    # functools.reduce lives outside the project; the call is credited to `total`
    write(tmp_path, {"pkg/__init__.py": "", "pkg/m.py": """
        import functools
        def add(a, b): return a + b
        def total(xs): return functools.reduce(add, xs)
    """})
    edges = run_in_subprocess(tmp_path, "from pkg.m import total; total([1, 2, 3])")
    assert edges[("pkg.m.total", "pkg.m.add")] == 2


def test_inner_functions_count_as_outer_and_import_time_is_ignored(tmp_path):
    write(tmp_path, {"pkg/__init__.py": "", "pkg/m.py": """
        def helper(): pass
        helper()                              # runs at import: not a function-to-function call
        def outer():
            def inner(): helper()
            inner()
    """})
    edges = run_in_subprocess(tmp_path, "from pkg.m import outer; outer()")
    assert edges == {("pkg.m.outer", "pkg.m.helper"): 1}


def test_merge_makes_hidden_dependency_visible(tmp_path):
    repo = tmp_path / "shop"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    out, proc = run_traced_tests(repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    trace = load_trace(out)
    assert trace["tests_run"] == 3

    static_only = Scanner(repo).scan()
    before = analyze(build_graph(static_only), ["app.services.hooks.send_receipt"])
    assert before.affected == [] and before.untested            # the code alone hides it

    result = Scanner(repo).scan()
    merge_trace(result, trace)
    after = analyze(build_graph(result), ["app.services.hooks.send_receipt"])
    assert [s.name for s in after.affected if s.kind == "route"] == ["app.routes.orders.place_order"]
    assert all(s.confidence == "dynamic" for s in after.affected)
    assert after.changed[0].reached_by_tests and not after.untested
    assert "tests/test_shop.py::test_place_order_sends_receipt" in after.tests_to_run


def test_confirmed_edges_are_marked_both(tmp_path):
    repo = tmp_path / "shop"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    out, _ = run_traced_tests(repo)
    result = Scanner(repo).scan()
    merge_trace(result, load_trace(out))
    a = analyze(build_graph(result), ["app.auth.decode_token"])
    assert {s.name: s.confidence for s in a.affected}["app.auth.current_user"] == "both"
    assert a.hidden_dependencies == []


def test_cli_trace_command(tmp_path, capsys):
    repo = tmp_path / "shop"
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    assert main(["trace", str(repo)]) == 0
    assert (repo / ".aftershock-trace.json").exists()
    assert main(["callers", str(repo), "send_receipt", "--trace", str(repo / ".aftershock-trace.json")]) == 0
    assert "Hidden dependencies" in capsys.readouterr().out


def test_constructor_calls_count_as_using_the_class():
    from aftershock.scanner import ScanResult, Symbol
    result = ScanResult()
    for name, kind in (("m.make", "function"), ("m.Repo", "class"), ("m.Repo.__init__", "method")):
        result.symbols[name] = Symbol(name, kind, "m.py", 1, 2, False, "m")
    merge_trace(result, {"version": 1, "edges": [["m.make", "m.Repo.__init__", 1]]})
    assert [(e.source, e.target) for e in result.edges] == [("m.make", "m.Repo")]
