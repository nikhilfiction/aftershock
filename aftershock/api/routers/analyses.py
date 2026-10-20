from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from aftershock.analysis import Analysis, DeletedInfo, Risk, SymbolInfo
from aftershock.api.deps import get_db, get_settings
from aftershock.api.models import AnalysisRow, Snapshot
from aftershock.api.scanning import ScanError, check_ref, check_subdir, mirror_path
from aftershock.api.schemas import AnalysisOut
from aftershock.api.settings import Settings
from aftershock.diff import DiffError, diff_text_between
from aftershock.render import to_markdown, to_text

MAX_DIFF_BYTES = 500_000

router = APIRouter(prefix="/analyses", tags=["analyses"])


def analysis_from_report(report: dict) -> Analysis:
    """Rebuilds the Analysis object from a saved report, so it can be re-rendered."""
    return Analysis(
        changed=[SymbolInfo(**s) for s in report["changed"]],
        affected=[SymbolInfo(**s) for s in report["affected"]],
        tests_to_run=report["tests_to_run"],
        deleted=[DeletedInfo(**d) for d in report["deleted"]],
        hidden_dependencies=report["hidden_dependencies"],
        risk=Risk(**report["risk"]),
        depth=report["depth"],
        test_command=report.get("test_command", ""),
    )


@router.get("/{analysis_id}", response_model=AnalysisOut,
            responses={200: {"content": {"text/markdown": {}, "text/plain": {}}}})
def get_analysis(
    analysis_id: int,
    format: str = Query("json", pattern="^(json|markdown|text)$"),
    db: Session = Depends(get_db),
):
    row = db.get(AnalysisRow, analysis_id)
    if row is None:
        raise HTTPException(404, f"Analysis {analysis_id} not found")
    if format == "markdown":
        return PlainTextResponse(to_markdown(analysis_from_report(row.result)), media_type="text/markdown")
    if format == "text":
        return PlainTextResponse(to_text(analysis_from_report(row.result)))
    return AnalysisOut(id=row.id, snapshot_id=row.snapshot_id, risk_score=row.risk_score,
                       risk_level=row.risk_level, created_at=row.created_at, report=row.result)


@router.get("/{analysis_id}/diff", response_class=PlainTextResponse,
            responses={200: {"content": {"text/plain": {}}}})
def analysis_diff(analysis_id: int, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)):
    """The diff an analysis was made from: the pasted one, or the branch's
    changes since it left the base branch (what a pull request shows)."""
    row = db.get(AnalysisRow, analysis_id)
    if row is None:
        raise HTTPException(404, f"Analysis {analysis_id} not found")
    if row.diff_text:
        text = row.diff_text
    elif row.base:
        snap = db.get(Snapshot, row.snapshot_id)
        mirror = mirror_path(settings, snap.repo_id)
        if not mirror.exists() or snap.commit_sha in (None, "working-tree"):
            raise HTTPException(404, "The git history for this scan is not available")
        try:
            text = diff_text_between(mirror, check_ref(row.base), snap.commit_sha,
                                     check_subdir(snap.repository.subdir))
        except (ScanError, DiffError) as exc:
            raise HTTPException(409, f"Could not rebuild the diff: {exc}")
    else:
        raise HTTPException(404, "This analysis is about a function, not a diff")
    if len(text) > MAX_DIFF_BYTES:
        text = text[:MAX_DIFF_BYTES] + "\n... (diff cut short)\n"
    return PlainTextResponse(text)
