"""Request and response shapes. FastAPI validates requests against these and
uses them to build the docs at /docs."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class RepoCreate(BaseModel):
    url: str = Field(description="https git URL, or a folder on the API's machine")
    name: str | None = None
    subdir: str = Field("", description="scan only this folder, e.g. 'backend'")
    default_branch: str = "HEAD"


class SnapshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    repo_id: int
    ref: str
    commit_sha: str | None
    status: str
    error: str | None
    want_dynamic: bool
    has_dynamic: bool
    symbol_count: int
    edge_count: int
    created_at: datetime
    scanned_at: datetime | None
    languages: list[str] = Field([], description="what the scan read, e.g. ['python', 'typescript']")
    test_runner: str = Field("", description="JS/TS projects: vitest, jest, mocha or node; Python uses pytest")

    @model_validator(mode="before")
    @classmethod
    def from_meta(cls, data):
        # a Snapshot row keeps these in its scan_meta column
        if isinstance(data, dict) or not hasattr(data, "scan_meta"):
            return data
        meta = data.scan_meta
        if meta is None and data.status == "ready":
            meta = {"languages": ["python"]}           # scanned before JavaScript support: Python only
        if meta is not None:
            data = {k: getattr(data, k) for k in cls.model_fields if hasattr(data, k)}
            data["languages"] = meta.get("languages", [])
            data["test_runner"] = meta.get("test_runner", "")
        return data


class RepoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    url: str
    subdir: str
    default_branch: str
    created_at: datetime


class RepoDetail(RepoOut):
    snapshots: list[SnapshotOut]


class ScanRequest(BaseModel):
    ref: str | None = Field(None, description="branch, tag or commit; defaults to the repo's default branch")
    dynamic: bool = Field(False, description="also run the test suite with tracing (Phase 4)")


class ScanQueued(BaseModel):
    snapshot: SnapshotOut
    queue: Literal["redis", "in-process"]


class SymbolOut(BaseModel):
    name: str
    kind: str
    file_path: str
    line: int
    is_test: bool
    route: str = Field("", description="routes only: method and path, e.g. 'GET /orders/'")


class SnapshotStats(BaseModel):
    languages: list[str] = Field([], description="e.g. ['python', 'typescript']")
    test_runner: str = Field("", description="JS/TS test runner; Python tests use pytest")
    symbols: int
    links: int
    files: int
    routes: int
    tests: int
    read_from_code: int = Field(description="links found by reading the code")
    seen_running: int = Field(description="links recorded while the tests ran")
    confirmed: int = Field(description="links found both ways")
    runtime_only: int = Field(description="links seen only while the tests ran (hidden from the code)")
    unresolved_calls: int


class SourceOut(BaseModel):
    path: str
    start: int
    lines: list[str]


class BlastRequest(BaseModel):
    """Exactly one of targets, diff or base."""
    targets: list[str] | None = Field(None, description="symbol names; short names like 'login' work if unique")
    diff: str | None = Field(None, description="unified diff text, e.g. the output of `git diff`")
    base: str | None = Field(None, description="compare the snapshot's commit against this ref, e.g. 'main'")
    depth: int = Field(3, ge=1, le=10)

    @model_validator(mode="after")
    def one_input(self):
        given = [x for x in (self.targets, self.diff, self.base) if x]
        if len(given) != 1:
            raise ValueError("send exactly one of: targets, diff, base")
        return self


class AffectedSymbol(BaseModel):
    name: str
    kind: str
    file_path: str
    line: int
    distance: int = Field(description="0 = changed itself, 1 = direct dependent, 2+ = indirect")
    via: list[str] = Field(description="chain from this symbol down to the changed one")
    reached_by_tests: bool
    confidence: Literal["static", "dynamic", "both"]
    route: str = Field("", description="routes only: method and path, e.g. 'GET /orders/'")
    call_line: int = Field(0, description="line where this symbol calls the next one in `via`; 0 if unknown")


class CallSite(BaseModel):
    caller: str
    file_path: str
    line: int


class DeletedSymbolOut(BaseModel):
    name: str
    file_path: str
    still_called_by: list[str]
    call_sites: list[CallSite] = []


class RiskOut(BaseModel):
    score: int = Field(ge=0, le=100)
    level: Literal["low", "medium", "high"]
    parts: dict[str, int]
    reasons: list[str]


class SummaryOut(BaseModel):
    changed: int
    direct: int
    indirect: int
    routes: int
    untested: int
    deleted_but_still_called: int


class Report(BaseModel):
    changed: list[AffectedSymbol]
    affected: list[AffectedSymbol]
    tests_to_run: list[str]
    deleted: list[DeletedSymbolOut]
    hidden_dependencies: list[str]
    risk: RiskOut
    depth: int
    summary: SummaryOut
    test_command: str = Field("", description="runs just tests_to_run, one line per test runner")


class AnalysisOut(BaseModel):
    id: int
    snapshot_id: int
    risk_score: int
    risk_level: str
    created_at: datetime
    report: Report


class GraphNode(BaseModel):
    id: str
    kind: str
    file_path: str
    line: int
    is_test: bool
    route: str = ""


class GraphEdge(BaseModel):
    source: str
    target: str
    kinds: list[str]
    confidence: str
    line: int = Field(0, description="where the source calls the target; 0 if unknown")


class GraphOut(BaseModel):
    focus: str | None
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool
