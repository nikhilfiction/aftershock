"""Runtime tracing for JavaScript/TypeScript tests (Vitest, Jest, Mocha, node --test).

The steps:
  1. copy the project to a temporary folder (the original is never changed)
  2. reuse its node_modules, or install dependencies into the copy
  3. instrument the copy: every function reports its name when it runs,
     without moving any line (js/scanner.cjs, `instrument`)
  4. run the tests with the tracing runtime preloaded (js/runtime.cjs)
  5. turn the recorded pairs into the same trace format the Python tracer writes

This executes the project's code and its install scripts. Only use it on code
you trust.
"""

import json
import os
import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

from aftershock.javascript import JS_SKIP_DIRS, RUNTIME, JsError, instrument, node_binary

LOCKFILES = [
    ("pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]),
    ("yarn.lock", ["yarn", "install", "--frozen-lockfile"]),
    ("bun.lockb", ["bun", "install"]),
    ("package-lock.json", ["npm", "ci", "--no-audit", "--no-fund"]),
]


def read_package(root: Path) -> dict:
    try:
        return json.loads((root / "package.json").read_text())
    except (OSError, ValueError):
        return {}


def detect_runner(pkg: dict) -> str:
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    script = pkg.get("scripts", {}).get("test", "")
    if "vitest" in deps or "vitest" in script:
        return "vitest"
    if "jest" in deps or "ts-jest" in deps or "jest" in script:
        return "jest"
    if "mocha" in deps or "mocha" in script:
        return "mocha"
    if "--test" in script:
        return "node"
    return ""


def has_js_tests(root: Path) -> bool:
    return (root / "package.json").is_file() and bool(detect_runner(read_package(root)))


def _copy_project(src: Path, dest: Path) -> None:
    ignore = shutil.ignore_patterns(*(JS_SKIP_DIRS - {"build", "dist", "out"}), ".aftershock-trace.json")
    shutil.copytree(src, dest, ignore=ignore, symlinks=True)


def _install(root: Path, timeout: int) -> None:
    for lockfile, cmd in LOCKFILES:
        if (root / lockfile).exists() and shutil.which(cmd[0]):
            break
    else:
        cmd = ["npm", "install", "--no-audit", "--no-fund"]
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise JsError(f"`{' '.join(cmd)}` failed: {(proc.stderr or proc.stdout).strip()[-800:]}")


def _command(runner: str, root: Path, report: Path) -> list[str]:
    bin_ = root / "node_modules" / ".bin"
    local = lambda name: str(bin_ / name) if (bin_ / name).exists() else name   # noqa: E731
    if runner == "vitest":
        return [local("vitest"), "run", "--reporter=default", "--reporter=json", f"--outputFile.json={report}"]
    if runner == "jest":
        return [local("jest"), "--ci", "--json", f"--outputFile={report}"]
    if runner == "mocha":
        return [local("mocha")]
    return [node_binary(), "--test"]


def _read_pairs(path: Path) -> list[list]:
    counts: Counter[tuple[str, str]] = Counter()
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split("\t")
            if parts[0] == "#count" and len(parts) == 4:
                counts[(parts[1], parts[2])] += int(parts[3]) - 1     # the first call is already counted
            elif len(parts) == 2:
                counts[(parts[0], parts[1])] += 1
    return [[a, b, n, 0] for (a, b), n in sorted(counts.items())]


def _test_counts(report: Path) -> tuple[int, int]:
    try:
        data = json.loads(report.read_text())
    except (OSError, ValueError):
        return 0, 0
    return int(data.get("numTotalTests", 0)), int(data.get("numFailedTests", 0))


def run_traced_js_tests(repo: str | Path, out: str | Path, timeout: int = 1800,
                        install: bool = True) -> tuple[dict, subprocess.CompletedProcess]:
    """Runs the project's JS/TS tests with tracing. Returns (trace, the test process).

    The trace has the same shape as the Python tracer's file: edges are
    [caller, callee, times called, line]. The line is 0, because the runtime
    knows which function called, not from which line.
    """
    repo = Path(repo).resolve()
    out = Path(out)
    pkg = read_package(repo)
    runner = detect_runner(pkg)
    if not runner:
        raise JsError("No test runner found in package.json (looked for vitest, jest, mocha and node --test)")

    with tempfile.TemporaryDirectory(prefix="aftershock-js-") as tmp:
        copy = Path(tmp) / "project"
        _copy_project(repo, copy)
        if (repo / "node_modules").is_dir():
            if not (copy / "node_modules").exists():
                (copy / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
        elif install:
            _install(copy, timeout)
        else:
            raise JsError("node_modules is missing; install the project's dependencies first")

        instrument(copy)
        pairs = Path(tmp) / "pairs.tsv"
        report = Path(tmp) / "report.json"
        env = {
            **os.environ,
            "NODE_OPTIONS": f'{os.environ.get("NODE_OPTIONS", "")} --require "{RUNTIME}"'.strip(),
            "AFTERSHOCK_TRACE_OUT": str(pairs),
            "CI": "true",
        }
        proc = subprocess.run(_command(runner, copy, report), cwd=copy, env=env, capture_output=True, text=True,
                              timeout=timeout)
        tests_run, tests_failed = _test_counts(report)
        trace = {
            "version": 1,
            "root": str(repo),
            "edges": _read_pairs(pairs),
            "tests_run": tests_run,
            "tests_failed": tests_failed,
            "runner": runner,
        }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(trace, indent=1))
    return trace, proc


def runner_reason(proc: subprocess.CompletedProcess) -> str:
    """The most useful line of a JS test run's output: its first error, if any."""
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(("Error:", "SyntaxError:", "TypeError:", "Cannot find module", "ReferenceError:")) \
                or "Error:" in stripped[:40]:
            return stripped[:500]
    return text.strip()[-500:]
