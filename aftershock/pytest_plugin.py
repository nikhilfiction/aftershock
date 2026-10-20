"""A pytest plugin that records runtime calls while the tests run.

It does nothing unless --aftershock-trace is given, so it is safe to load anywhere:

    python -m pytest -p aftershock.pytest_plugin --aftershock-trace=trace.json
"""

import json
from pathlib import Path

from aftershock.tracing import Tracer

_state: dict = {}


def pytest_addoption(parser):
    group = parser.getgroup("aftershock")
    group.addoption("--aftershock-trace", default=None, help="record runtime calls into this JSON file")
    group.addoption("--aftershock-root", default=None, help="project folder to trace (default: pytest's rootdir)")


def pytest_configure(config):
    out = config.getoption("--aftershock-trace")
    if not out:
        return
    root = config.getoption("--aftershock-root") or str(config.rootpath)
    tracer = Tracer(root)
    _state.update(tracer=tracer, out=Path(out), collected=0, failed=0)
    tracer.start()


def pytest_runtest_logreport(report):
    if "tracer" in _state and report.when == "call":
        _state["collected"] += 1
        _state["failed"] += int(report.failed)


def pytest_unconfigure(config):
    tracer = _state.pop("tracer", None)
    if tracer is None:
        return
    tracer.stop()
    data = tracer.to_dict(tests_run=_state["collected"], tests_failed=_state["failed"])
    _state["out"].write_text(json.dumps(data, indent=1))
