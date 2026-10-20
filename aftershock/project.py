"""Scans a project in every language it contains and joins the results.

Python files go through the Python scanner (scanner.py), JavaScript and
TypeScript files through the Node scanner (javascript.py). Both produce the
same symbols and links, so one graph can hold a Python backend and a
TypeScript frontend side by side.
"""

import json
import os
import subprocess
import tempfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from aftershock.javascript import JsError, count_js_files, has_js_files, scan_js
from aftershock.js_tracing import has_js_tests, run_traced_js_tests, runner_reason
from aftershock.scanner import SKIP_DIRS, Scanner, ScanResult, is_test_path
from aftershock.tracing import load_trace, pytest_reason, run_traced_tests


def iter_python_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and d != "node_modules"]
        for name in filenames:
            if name.endswith(".py"):
                yield Path(dirpath) / name


def has_python_files(root: Path) -> bool:
    return next(iter_python_files(root), None) is not None


def count_source_files(root: str | Path) -> int:
    root = Path(root)
    return sum(1 for _ in iter_python_files(root)) + count_js_files(root)


def scan_project(root: str | Path) -> ScanResult:
    """Every symbol and link in the folder, whatever the language.

    If the folder has JavaScript/TypeScript but Node is missing, the Python part
    is still scanned and the reason is kept in meta["warnings"]; with no Python
    files at all that becomes an error.
    """
    root = Path(root).resolve()
    languages: list[str] = []
    warnings: list[str] = []
    result = ScanResult()

    if has_python_files(root):
        result = Scanner(root).scan()
        languages.append("python")

    test_runner = ""
    if has_js_files(root):
        try:
            js = scan_js(root)
        except JsError as exc:
            if not languages:
                raise
            warnings.append(f"JavaScript/TypeScript files were not scanned: {exc}")
        else:
            for name, sym in js.symbols.items():
                result.symbols.setdefault(name, sym)
            result.edges.extend(js.edges)
            result.unresolved_calls.extend(js.unresolved_calls)
            languages.extend(js.meta.get("languages", []))
            test_runner = js.meta.get("test_runner", "")

    result.meta = {"languages": languages, "test_runner": test_runner, "warnings": warnings}
    return result


# ---------------------------------------------------------------- tracing every language

@dataclass
class TraceOutcome:
    trace: dict | None                                   # all runtime calls, None if no test could run
    problems: list[str] = field(default_factory=list)    # plain sentences, e.g. why pytest could not start
    summaries: list[str] = field(default_factory=list)   # one line per test runner, e.g. "pytest: 3 passed"


def has_python_tests(root: Path) -> bool:
    return any(is_test_path(p.relative_to(root).as_posix()) for p in iter_python_files(root))


def trace_project(root: str | Path, out: str | Path, timeout: int = 1800, pytest_args: list[str] = (),
                  install: bool = True) -> TraceOutcome:
    """Runs the project's tests with tracing: pytest for Python, the package.json
    test runner for JavaScript/TypeScript, or both. Writes one trace file to `out`."""
    root = Path(root).resolve()
    out = Path(out)
    outcome = TraceOutcome(trace=None)
    traces = []
    js_tests = has_js_tests(root)

    with tempfile.TemporaryDirectory(prefix="aftershock-trace-") as tmp:
        if has_python_files(root) and (has_python_tests(root) or not js_tests):
            try:
                path, proc = run_traced_tests(root, Path(tmp) / "python.json", pytest_args, timeout)
            except subprocess.TimeoutExpired:
                outcome.problems.append(f"pytest was stopped after {timeout}s")
            else:
                outcome.summaries.append("pytest: " + ((proc.stdout or "").strip().splitlines() or ["no output"])[-1])
                trace = load_trace(path) if path.exists() else None
                if trace is None:
                    outcome.problems.append(f"The tests could not run, so there is no runtime data. "
                                            f"pytest said: {pytest_reason(proc)}")
                elif not trace["edges"] and not trace.get("tests_run"):
                    outcome.problems.append(f"No test could run, so there is no runtime data. "
                                            f"pytest said: {pytest_reason(proc)}")
                else:
                    traces.append(trace)

        if js_tests:
            try:
                trace, proc = run_traced_js_tests(root, Path(tmp) / "js.json", timeout, install)
            except subprocess.TimeoutExpired:
                outcome.problems.append(f"The JavaScript tests were stopped after {timeout}s")
            except JsError as exc:
                outcome.problems.append(f"The JavaScript tests could not run, so there is no runtime data: {exc}")
            else:
                runner = trace["runner"]
                outcome.summaries.append(f"{runner}: {trace['tests_run']} tests, {trace['tests_failed']} failed")
                if not trace["edges"] and not trace["tests_run"]:
                    outcome.problems.append(f"No test could run, so there is no runtime data. "
                                            f"{runner} said: {runner_reason(proc)}")
                else:
                    traces.append(trace)

    if traces:
        counts: Counter[tuple[str, str]] = Counter()
        lines: dict[tuple[str, str], int] = {}
        for t in traces:
            for edge in t["edges"]:
                a, b, n = edge[:3]
                counts[(a, b)] += n
                if len(edge) > 3 and edge[3] and (a, b) not in lines:
                    lines[(a, b)] = edge[3]
        outcome.trace = {
            "version": 1,
            "root": str(root),
            "edges": [[a, b, n, lines.get((a, b), 0)] for (a, b), n in sorted(counts.items())],
            "tests_run": sum(t.get("tests_run", 0) for t in traces),
            "tests_failed": sum(t.get("tests_failed", 0) for t in traces),
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(outcome.trace, indent=1))
    return outcome
