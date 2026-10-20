"""Dynamic analysis: watch the code run and record which function really called which.

Static analysis reads code and misses anything decided at runtime, such as
`globals()[name]()`, plugins loaded by name, or callbacks stored in a dict.
The tracer fills that gap: it hooks into Python with sys.setprofile, which
calls us on every function call, and records (caller, callee) pairs for
functions that live inside the project folder.

Run it through pytest so every test exercises the code:

    aftershock trace path/to/repo          # writes path/to/repo/.aftershock-trace.json
"""

import json
import os
import subprocess
import sys
import threading
from collections import Counter
from pathlib import Path

from aftershock.scanner import SKIP_DIRS, Edge, ScanResult, module_name_for

TRACE_FILE = ".aftershock-trace.json"
MAX_HOPS = 50          # how far up the stack we look for a project frame
_MODULE_LEVEL = ""     # marker: code that runs at import time, not inside a function


class Tracer:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self._prefix = str(self.root) + os.sep
        self.edges: Counter[tuple[str, str]] = Counter()
        self.lines: dict[tuple[str, str], int] = {}   # the line of the first call seen, per pair
        self._names: dict = {}           # code object -> qualified name, None, or _MODULE_LEVEL

    # ---- naming

    def _name(self, code) -> str | None:
        """The symbol a code object belongs to. Cached, because this runs on every call."""
        try:
            return self._names[code]
        except KeyError:
            pass

        name = None
        # realpath: on macOS /var is a link to /private/var, and code may report either form
        filename = os.path.realpath(code.co_filename) if code.co_filename.endswith(".py") else ""
        if filename.startswith(self._prefix):
            rel = Path(filename).relative_to(self.root)
            if not any(part in SKIP_DIRS for part in rel.parts):     # e.g. a venv inside the project
                module = module_name_for(Path(filename), self.root)
                qualname = getattr(code, "co_qualname", code.co_name)   # co_qualname: Python 3.11+
                # inner functions, lambdas and comprehensions count as their outer function,
                # exactly like the static scanner treats them
                qualname = qualname.split(".<locals>")[0]
                name = _MODULE_LEVEL if qualname == "<module>" else f"{module}.{qualname}"

        self._names[code] = name
        return name

    # ---- the hook

    def _profile(self, frame, event, arg):
        if event != "call":
            return
        callee = self._name(frame.f_code)
        if not callee:                       # outside the project, or module-level code
            return

        # Walk up to the nearest project frame. Frames from libraries in between
        # (a web framework calling your dependency, a decorator from a package)
        # are skipped, so the call is credited to the project function behind it.
        caller_frame = frame.f_back
        for _ in range(MAX_HOPS):
            if caller_frame is None:
                return
            caller = self._name(caller_frame.f_code)
            if caller == _MODULE_LEVEL:      # called while a module was being imported: skip
                return
            if caller is not None:
                if caller != callee:
                    pair = (caller, callee)
                    self.edges[pair] += 1
                    if pair not in self.lines:
                        self.lines[pair] = caller_frame.f_lineno
                return
            caller_frame = caller_frame.f_back

    def start(self) -> None:
        threading.setprofile(self._profile)  # threads started from now on
        sys.setprofile(self._profile)        # this thread

    def stop(self) -> None:
        sys.setprofile(None)
        threading.setprofile(None)

    def to_dict(self, **extra) -> dict:
        return {
            "version": 1,
            "root": str(self.root),
            # [caller, callee, times called, line of the call in the caller]
            "edges": [[a, b, n, self.lines.get((a, b), 0)] for (a, b), n in sorted(self.edges.items())],
            **extra,
        }


# ---------------------------------------------------------------- running and loading

def run_traced_tests(repo: str | Path, out: str | Path | None = None, pytest_args: list[str] = (),
                     timeout: int = 1800) -> tuple[Path, subprocess.CompletedProcess]:
    """Runs the repo's tests under the tracer, in a separate Python process.

    The repo's own dependencies must be installed in the current environment,
    otherwise its tests fail to import. Failing tests are fine: everything
    that ran before the failure is still recorded.
    """
    repo = Path(repo).resolve()
    out = Path(out).resolve() if out else repo / TRACE_FILE
    cmd = [sys.executable, "-m", "pytest", "-p", "aftershock.pytest_plugin",
           f"--aftershock-trace={out}", f"--aftershock-root={repo}", "-q", "-p", "no:cacheprovider", *pytest_args]
    proc = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=timeout)
    return out, proc


def pytest_reason(proc: subprocess.CompletedProcess) -> str:
    """The most useful line of pytest's output: its last error (`E   ImportError: ...`), if any."""
    text = (proc.stdout or "") + (proc.stderr or "")
    errors = [line[1:].strip() for line in text.splitlines() if line.startswith("E ")]
    return errors[-1] if errors else text.strip()[-500:]


def load_trace(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text())
    if data.get("version") != 1:
        raise ValueError(f"{path} is not a aftershock trace file")
    return data


def trace_edges(trace: dict):
    """(caller, callee, count, line) for each recorded pair. Trace files written
    before lines were recorded have three items per edge; their line is 0."""
    for edge in trace["edges"]:
        caller, callee, count = edge[:3]
        yield caller, callee, count, (edge[3] if len(edge) > 3 else 0)


def merge_trace(result: ScanResult, trace: dict) -> int:
    """Adds runtime edges to a static scan. Returns how many were added.

    Pairs whose names the scanner does not know (e.g. a method of a class
    nested inside a function) are dropped.
    """
    added = 0
    for caller, callee, count, line in trace_edges(trace):
        # the scanner records `Repo()` as a use of the class Repo; the tracer sees
        # Repo.__init__ run. Same fact, so record it under the scanner's name.
        if callee.endswith(".__init__") and callee[: -len(".__init__")] in result.symbols:
            callee = callee[: -len(".__init__")]
        if caller == callee:
            continue
        if caller in result.symbols and callee in result.symbols:
            result.edges.append(Edge(caller, callee, "calls", line, origin="dynamic", count=count))
            added += 1
    return added
