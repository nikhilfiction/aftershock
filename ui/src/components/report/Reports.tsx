/**
 * The two report layouts. A branch comparison or a pasted diff reads like a
 * pull request review: what breaks, the radar and the code, the routes and
 * tests. A single function reads like an investigation: the radar, the call
 * graph, and who calls it, with the code that does.
 */
import { lazy, Suspense, useState, type Dispatch, type SetStateAction } from "react";

import { useAnalysisDiff, useSymbolsOfKind } from "../../api/hooks";
import type { Analysis, Report, Snapshot } from "../../api/types";
import { parseDiff } from "../../lib/diff";
import { shortLabel, splitRoute } from "../../lib/format";
import type { Mode } from "../../lib/report";
import { Icon } from "../Icon";
import { SkeletonLines } from "../ui";
import { Inspector } from "./Inspector";
import {
  ActionsPanel,
  BreakingAlert,
  DiffPanel,
  FileTreePanel,
  NodeDetail,
  RadarFiltersPanel,
  RoutesPanel,
  ScoreBreakdown,
  SummaryTiles,
  TestsPanel,
  VerdictStrip,
} from "./panels";
import type { FilterKey } from "../../lib/radarLayout";
import { Radar } from "./Radar";

const GraphPanel = lazy(() => import("./GraphPanel"));

function GraphFallback() {
  return (
    <div className="panel">
      <SkeletonLines rows={6} height={28} />
    </div>
  );
}

function originText(r: Report): string {
  const changed = r.changed.map((s) => `${shortLabel(s.name, s.kind)}()`);
  const deleted = r.deleted.map((d) => `${shortLabel(d.name)}()`);
  if (changed.length === 1 && deleted.length === 0) return changed[0];
  const parts = [];
  if (changed.length) parts.push(changed.length <= 2 ? changed.join(", ") : `${changed.length} functions`);
  if (deleted.length) parts.push(`deleted ${deleted.length <= 2 ? deleted.join(", ") : `${deleted.length} functions`}`);
  return parts.join("; ") || "nothing";
}

function RadarPanel({
  report,
  variant,
  hidden,
  setHidden,
  viewToggle,
  breakdown,
  onAnalyze,
}: {
  report: Report;
  variant: "wide" | "tall";
  hidden: Set<FilterKey>;
  setHidden: Dispatch<SetStateAction<Set<FilterKey>>>;
  viewToggle: boolean;
  breakdown: boolean;
  onAnalyze: (name: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const hasRuntime = report.affected.some((s) => s.confidence === "dynamic");
  const codeOnly = hidden.has("runtime");
  const setCodeOnly = (on: boolean) =>
    setHidden((old) => {
      const next = new Set(old);
      if (on) next.add("runtime");
      else next.delete("runtime");
      return next;
    });

  return (
    <section className={`panel radar-panel ${variant}`} aria-labelledby="radar-h">
      <div className="panel-head">
        <div>
          <h2 id="radar-h">Dependency radar</h2>
          <div className="label quiet">
            Origin: <span className="mono c-primary normal-case">{originText(report)}</span> [Changed]
          </div>
        </div>
        <div className="row-gap">
          <span className="chip plain only-desktop">Rings: steps away</span>
          {viewToggle && hasRuntime && (
            <div className="seg-toggle" role="group" aria-label="Which links to show">
              <button type="button" aria-pressed={!codeOnly} onClick={() => setCodeOnly(false)}>
                Code + runtime
              </button>
              <button type="button" aria-pressed={codeOnly} onClick={() => setCodeOnly(true)}>
                Code only
              </button>
            </div>
          )}
        </div>
      </div>
      <Radar
        report={report}
        hidden={hidden}
        variant={variant}
        selected={picked}
        onPick={(name) => setPicked((p) => (p === name ? null : name))}
      />
      {picked && <NodeDetail report={report} name={picked} onAnalyze={onAnalyze} onClose={() => setPicked(null)} />}
      {breakdown && <ScoreBreakdown report={report} />}
    </section>
  );
}

type ReportProps = {
  analysis: Analysis;
  snapshot: Snapshot;
  repoName: string;
  mode: Mode;
  base: string;
  onAnalyze: (name: string) => void;
};

/** A branch comparison or a pasted diff. */
export function ChangeReport({ analysis, snapshot, repoName, mode, base, onAnalyze }: ReportProps) {
  const r = analysis.report;
  const [hidden, setHidden] = useState<Set<FilterKey>>(() => new Set());
  const diff = useAnalysisDiff(analysis.id, true);
  const rangeLabel = mode === "base" ? `${base}...${snapshot.ref}` : "pasted diff";
  const change = diff.data
    ? { label: mode === "base" ? `Changed in ${rangeLabel}` : "Changed in the pasted diff", files: parseDiff(diff.data) }
    : null;

  return (
    <div className="report change-report">
      <SummaryTiles report={r} />
      <BreakingAlert report={r} mode={mode} />
      <div className="change-grid">
        <div className="col col-left">
          <div className="slot slot-tree">
            <FileTreePanel snapshotId={snapshot.id} report={r} repoName={repoName} change={change} />
          </div>
          <div className="slot slot-filters">
            <RadarFiltersPanel hidden={hidden} setHidden={setHidden} />
          </div>
        </div>
        <div className="col col-mid">
          <div className="slot slot-radar">
            <RadarPanel
              report={r}
              variant="wide"
              hidden={hidden}
              setHidden={setHidden}
              viewToggle={false}
              breakdown
              onAnalyze={onAnalyze}
            />
          </div>
          <div className="slot slot-diff">
            <DiffPanel analysis={analysis} rangeLabel={rangeLabel} />
          </div>
        </div>
        <div className="col col-right">
          <div className="slot slot-routes">
            <RoutesPanel report={r} mode={mode} />
          </div>
          <div className="slot slot-tests">
            <TestsPanel report={r} />
          </div>
          <div className="slot slot-actions">
            <ActionsPanel analysis={analysis} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One function. */
export function FunctionReport({ analysis, snapshot, onAnalyze }: ReportProps) {
  const r = analysis.report;
  const [hidden, setHidden] = useState<Set<FilterKey>>(() => new Set());
  const target = r.changed[0]?.name ?? null;
  const [focus, setFocus] = useState<string | null>(target);

  return (
    <div className="report fn-grid">
      <div className="fn-main">
        <SummaryTiles report={r} />
        <VerdictStrip report={r} />
        <RadarPanel
          report={r}
          variant="tall"
          hidden={hidden}
          setHidden={setHidden}
          viewToggle
          breakdown={false}
          onAnalyze={onAnalyze}
        />
        <div className="fn-graph">
          <Suspense fallback={<GraphFallback />}>
            <GraphPanel snapshotId={snapshot.id} focus={focus} report={r} onFocus={setFocus} onAnalyze={onAnalyze} />
          </Suspense>
        </div>
      </div>
      <Inspector snapshotId={snapshot.id} analysis={analysis} />
    </div>
  );
}

/** Before anything is analyzed: where to start, and the map of the files. */
export function Intro({ snapshot, onAnalyze }: { snapshot: Snapshot; onAnalyze: (name: string) => void }) {
  const routes = useSymbolsOfKind(snapshot.id, "route");
  const [focus, setFocus] = useState<string | null>(null);
  const list = (routes.data ?? []).filter((s) => !s.is_test).slice(0, 12);
  return (
    <div className="report intro-grid">
      <section className="panel intro" aria-labelledby="intro-h">
        <h2 id="intro-h" className="panel-title">
          <Icon name="radar" size={20} className="c-primary" />
          What would a change affect?
        </h2>
        <p className="soft">
          Pick a function in the bar above, paste a diff, or compare this branch with another one, like a pull request.
          You will see everything that depends on the change, the API routes that run it, and the tests to run.
        </p>
        {routes.isPending && <SkeletonLines rows={3} height={16} />}
        {list.length > 0 && (
          <>
            <p className="label quiet">Or start from one of its API routes</p>
            <ul className="quick-list">
              {list.map((s) => {
                const { method, path } = s.route ? splitRoute(s.route) : { method: "API", path: shortLabel(s.name) };
                return (
                  <li key={s.name}>
                    <button type="button" className="quick" onClick={() => onAnalyze(s.name)}>
                      <span className="method">{method}</span>
                      <span className="mono">{path}</span>
                      {shortLabel(s.name) !== s.route && <span className="mono faint">{shortLabel(s.name)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
      <Suspense fallback={<GraphFallback />}>
        <GraphPanel snapshotId={snapshot.id} focus={focus} onFocus={setFocus} onAnalyze={onAnalyze} />
      </Suspense>
    </div>
  );
}
