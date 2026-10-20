/** The panels a report is built from. Each one is a section with its own heading. */
import { useState, type Dispatch, type SetStateAction } from "react";

import { fetchMarkdown, useAnalysisDiff, useSymbolsOfKind } from "../../api/hooks";
import type { AffectedSymbol, Analysis, Report } from "../../api/types";
import { diffTotals, parseDiff, type DiffFile } from "../../lib/diff";
import { treeRows } from "../../lib/files";
import { downloadText, fileName, plural, shortLabel, splitRoute } from "../../lib/format";
import {
  FILE_MARK_TEXT,
  breaksThrough,
  brokenDeletions,
  fileMarks,
  routeNote,
  routesOf,
  scoreParts,
  testCommands,
  testName,
  testRunnerName,
  tilesFor,
  type Mode,
  type Tile,
} from "../../lib/report";
import { scrollToId } from "../../lib/useLayout";
import { verdictSentences } from "../../lib/verdict";
import { Icon, type IconName } from "../Icon";
import { CopyButton, ErrorBanner, SkeletonLines } from "../ui";
import { FILTERS, type FilterKey } from "../../lib/radarLayout";

const TILE_ICON: Record<string, IconName> = {
  risk: "target",
  broken: "xCircle",
  depends: "graph",
  routes: "hash",
  hidden: "eye",
  tests: "checkCircle",
};

function TileBody({ t }: { t: Tile }) {
  return (
    <>
      <div className="tile-head">
        <span className="tile-label">{t.label}</span>
        {t.badge ? <span className="tile-badge">{t.badge}</span> : <Icon name={TILE_ICON[t.key]} size={18} stroke={1.8} />}
      </div>
      <div className="tile-number">
        <span className="tile-value">{t.value}</span>
        <span className="tile-unit">{t.unit}</span>
      </div>
      {t.bar !== undefined && (
        <div className="tile-bar" role="img" aria-label={`${t.bar} out of 100`}>
          <div style={{ width: `${t.bar}%` }} />
        </div>
      )}
      {t.note && <div className="tile-note">{t.note}</div>}
    </>
  );
}

/** One coloured number per finding; each jumps to its section. */
export function SummaryTiles({ report }: { report: Report }) {
  return (
    <ul className="tiles" aria-label="Summary">
      {tilesFor(report).map((t) => (
        <li key={t.key} className={`tile tone-${t.tone}`} data-key={t.key}>
          {t.target ? (
            <a
              className="tile-link"
              href={`#${t.target}`}
              onClick={(e) => {
                e.preventDefault();
                scrollToId(t.target!);
              }}
            >
              <TileBody t={t} />
            </a>
          ) : (
            <div className="tile-link">
              <TileBody t={t} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The red box: a deleted function that something still calls. */
export function BreakingAlert({ report, mode }: { report: Report; mode: Mode }) {
  const broken = brokenDeletions(report);
  if (!broken.length) return null;
  const where = mode === "base" ? "in this branch" : mode === "diff" ? "in this diff" : "";
  return (
    <section className="alert-broken" aria-labelledby="broken-h">
      <Icon name="alertCircle" size={20} className="alert-icon" />
      <div className="alert-body">
        <h2 id="broken-h">
          <span className="only-desktop">Breaking change detected</span>
          <span className="only-phone">Will break: call to deleted function</span>
        </h2>
        {broken.map((d) => {
          const sites = d.call_sites.map((c) => `${c.file_path}:${c.line}`);
          return (
            <p key={d.name}>
              <span className="c-broken strong">{d.name}</span> was deleted{where && ` ${where}`}, but{" "}
              {d.still_called_by.map((c, i) => (
                <span key={c}>
                  {i > 0 && ", "}
                  <span className="c-primary strong">{c}</span>
                </span>
              ))}{" "}
              still {plural(d.still_called_by.length, "calls", "call")} it{sites.length ? ` at ${sites.join(", ")}` : ""}.
            </p>
          );
        })}
      </div>
      <a
        className="btn small"
        href="#radar-h"
        onClick={(e) => {
          e.preventDefault();
          scrollToId("radar-h");
        }}
      >
        Show in radar
      </a>
    </section>
  );
}

/** "How the score adds up": one bar segment per factor. */
export function ScoreBreakdown({ report }: { report: Report }) {
  const parts = scoreParts(report);
  if (!parts.length) return null;
  const total = Math.max(100, parts.reduce((n, p) => n + p.points, 0));
  return (
    <div className="breakdown">
      <div className="breakdown-head label quiet">
        <span>How the score adds up:</span>
        <span>Total: {report.risk.score} pts</span>
      </div>
      <div
        className="breakdown-bar"
        role="img"
        aria-label={parts.map((p) => `${p.label} ${p.points}`).join(", ")}
      >
        {parts.map((p) => (
          <div key={p.key} className={`seg part-${p.key}`} style={{ width: `${(100 * p.points) / total}%` }} />
        ))}
      </div>
      <ul className="breakdown-key mono">
        {parts.map((p) => (
          <li key={p.key}>
            <span className={`dot part-${p.key}`} aria-hidden="true" /> {p.label} (+{p.points})
          </li>
        ))}
      </ul>
    </div>
  );
}

function MethodPath({ s, broken }: { s: AffectedSymbol; broken: boolean }) {
  if (!s.route) {
    return (
      <span className="route-title">
        <span className={`method${broken ? " broken" : ""}`}>API</span>
        <span>{shortLabel(s.name)}</span>
      </span>
    );
  }
  const { method, path } = splitRoute(s.route);
  return (
    <span className="route-title">
      <span className={`method${broken ? " broken" : ""}`}>{method}</span>
      <span>{path}</span>
    </span>
  );
}

/** The API routes that end up running the changed code. */
export function RoutesPanel({ report, mode }: { report: Report; mode: Mode }) {
  const routes = routesOf(report);
  const what = mode === "base" ? "branch" : mode === "diff" ? "diff" : "change";
  return (
    <section className="panel tight" aria-labelledby="routes-h">
      <div className="panel-head">
        <h2 id="routes-h">Exposed API routes</h2>
        <span className="count">
          {routes.length} {plural(routes.length, "target", "targets")}
        </span>
      </div>
      {routes.length === 0 ? (
        <p className="soft small">No API route runs this code.</p>
      ) : (
        <>
          <p className="label quiet normal-case">These endpoints run code changed or deleted in this {what}.</p>
          <ul className="route-list">
            {routes.map((s) => {
              const broken = Boolean(breaksThrough(report, s));
              const status = s.distance === 0 ? "changed" : broken ? "breaking" : "affected";
              return (
                <li key={s.name} className="route-card">
                  <div className="route-top">
                    <MethodPath s={s} broken={broken} />
                    <span className={`route-status ${status}`}>{status.toUpperCase()}</span>
                  </div>
                  <div className="route-where mono" title={s.name}>
                    {shortLabel(s.name) !== s.route && `${shortLabel(s.name)} · `}
                    {s.file_path}:{s.line}
                  </div>
                  <div className={`route-note${broken ? " c-broken" : ""}`}>
                    <Icon name={broken ? "warning" : "fork"} size={14} />
                    {routeNote(report, s)}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** The tests that reach the change, and the command that runs just those. */
export function TestsPanel({ report }: { report: Report }) {
  const tests = report.tests_to_run;
  const command = testCommands(report).join("\n");
  return (
    <section className="panel tight" aria-labelledby="tests-h">
      <div className="panel-head">
        <h2 id="tests-h">Tests to run</h2>
        <span className="mono faint small">
          {tests.length} · {testRunnerName(report)}
        </span>
      </div>
      {tests.length === 0 ? (
        <p className="soft small">No test reaches the changed code. Consider adding one before merging.</p>
      ) : (
        <>
          <ul className="test-list mono">
            {tests.map((t) => (
              <li key={t} title={t}>
                {testName(t)}
              </li>
            ))}
          </ul>
          <div className="command">
            <div className="command-head">
              <span className="label quiet">Targeted test command</span>
              <CopyButton label="Copy" ariaLabel="Copy test command" getText={() => command} className="text-btn" />
            </div>
            <div className="command-box mono">{command}</div>
          </div>
        </>
      )}
    </section>
  );
}

/** Copy the report for a pull request, or save it as JSON. */
export function ReportActions({ analysis, primary = false }: { analysis: Analysis; primary?: boolean }) {
  return (
    <div className="actions">
      <CopyButton
        label="Copy report as Markdown"
        icon="markdown"
        className="btn block"
        getText={() => fetchMarkdown(analysis.id)}
      />
      <button
        type="button"
        className={`btn block${primary ? " primary" : ""}`}
        onClick={() => downloadText(`aftershock-${analysis.id}.json`, JSON.stringify(analysis, null, 2))}
      >
        <Icon name="download" size={16} stroke={1.8} />
        Download as JSON
      </button>
    </div>
  );
}

export function ActionsPanel({ analysis }: { analysis: Analysis }) {
  return (
    <section className="panel tight" aria-labelledby="actions-h">
      <h2 id="actions-h" className="label quiet">
        Report actions
      </h2>
      <ReportActions analysis={analysis} />
    </section>
  );
}

const MAX_TREE = 40;

/** The scan's files as a tree, with the ones this report touches marked. */
export function FileTreePanel({
  snapshotId,
  report,
  repoName,
  change,
}: {
  snapshotId: number;
  report: Report;
  repoName: string;
  change: { label: string; files: DiffFile[] } | null;
}) {
  const modules = useSymbolsOfKind(snapshotId, "module");
  const marks = fileMarks(report);
  const all = modules.data?.map((m) => m.file_path) ?? [];
  const shown = all.length > MAX_TREE ? all.filter((p) => marks.has(p)) : all;
  const rows = treeRows(shown);
  const totals = change ? diffTotals(change.files) : null;

  return (
    <section className="panel tight" aria-labelledby="tree-h">
      <div className="panel-head">
        <h2 id="tree-h" className="label quiet">
          Files in this scan
        </h2>
        <span className="mono c-primary small">{repoName}</span>
      </div>
      {modules.isPending && <SkeletonLines rows={5} height={14} />}
      {modules.isError && <ErrorBanner error={modules.error} onRetry={() => modules.refetch()} />}
      <ul className="tree mono">
        {rows.map((row) => {
          const mark = row.dir ? undefined : marks.get(row.path);
          return (
            <li
              key={row.key}
              className={`tree-row${row.dir ? " dir" : ""}${mark ? ` mark-${mark}` : ""}`}
              style={{ paddingLeft: 6 + row.depth * 16 }}
            >
              <span>{row.name}</span>
              {mark && (
                <span className="tree-mark" title={FILE_MARK_TEXT[mark]}>
                  <span className="sr-only">{FILE_MARK_TEXT[mark]}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {all.length > shown.length && (
        <p className="faint mono small">
          {all.length - shown.length} other {plural(all.length - shown.length, "file", "files")} not shown
        </p>
      )}
      {change && totals && (
        <div className="change-box">
          <div className="change-box-head label quiet">
            <span>{change.label}</span>
            <span className={`mini-tag level-${report.risk.level}`}>{report.risk.level} risk</span>
          </div>
          <div className="mono small">
            {change.files.length} {plural(change.files.length, "file", "files")} changed,{" "}
            <span className="c-add">+{totals.added}</span> <span className="c-broken">−{totals.removed}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Checkboxes that show or hide kinds of points on the radar. */
export function RadarFiltersPanel({
  hidden,
  setHidden,
}: {
  hidden: Set<FilterKey>;
  setHidden: Dispatch<SetStateAction<Set<FilterKey>>>;
}) {
  return (
    <section className="panel tight" aria-labelledby="filter-h">
      <h2 id="filter-h" className="label quiet">
        Filter radar points
      </h2>
      <ul className="filters">
        {FILTERS.map((f) => (
          <li key={f.key}>
            <label>
              <span className="filter-name">
                <span className={`dot filter-${f.key}`} aria-hidden="true" />
                {f.label}
              </span>
              <input
                type="checkbox"
                className={`filter-${f.key}`}
                checked={!hidden.has(f.key)}
                onChange={(e) =>
                  setHidden((old) => {
                    const next = new Set(old);
                    if (e.target.checked) next.delete(f.key);
                    else next.add(f.key);
                    return next;
                  })
                }
              />
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

const MAX_DIFF_LINES = 300;

export function DiffView({ files }: { files: DiffFile[] }) {
  const [all, setAll] = useState(false);
  const total = files.reduce((n, f) => n + f.lines.length, 0);
  // how many lines of each file fit in the budget, worked out before drawing
  const shown = files.reduce<{ left: number; parts: { file: DiffFile; count: number }[] }>(
    (acc, file) => {
      const count = Math.max(0, Math.min(file.lines.length, acc.left));
      return { left: acc.left - count, parts: [...acc.parts, { file, count }] };
    },
    { left: all ? Infinity : MAX_DIFF_LINES, parts: [] },
  ).parts;
  return (
    <div className="diff mono">
      {shown
        .filter((p) => p.count > 0)
        .map(({ file: f, count }) => (
          <div key={f.path} className="diff-file">
            <div className="diff-path">
              <span>{f.path}</span>
              <span>
                {f.removed > 0 && <span className="c-broken">−{f.removed}</span>}{" "}
                {f.added > 0 && <span className="c-add">+{f.added}</span>}
              </span>
            </div>
            <div className="diff-lines">
              {f.lines.slice(0, count).map((l, i) =>
                l.kind === "gap" ? (
                  <div key={i} className="diff-line gap" aria-hidden="true">
                    <span className="ln">⋯</span>
                  </div>
                ) : (
                  <div key={i} className={`diff-line ${l.kind}`}>
                    <span className="ln">
                      {l.kind === "del" ? `${l.oldNo} -` : l.kind === "add" ? `${l.newNo} +` : l.newNo}
                    </span>
                    <span className="code">{l.text || " "}</span>
                  </div>
                ),
              )}
            </div>
          </div>
        ))}
      {total > MAX_DIFF_LINES && (
        <button type="button" className="text-btn" onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : `Show all ${total} lines`}
        </button>
      )}
    </div>
  );
}

/** The code behind a diff or branch comparison. */
export function DiffPanel({ analysis, rangeLabel }: { analysis: Analysis; rangeLabel: string }) {
  const diff = useAnalysisDiff(analysis.id, true);
  const files = diff.data ? parseDiff(diff.data) : [];
  const totals = diffTotals(files);
  return (
    <section className="panel tight diff-panel" aria-labelledby="diff-h">
      <details open>
        <summary className="panel-head">
          <span className="panel-title">
            <Icon name="diff" size={18} stroke={1.8} className="faint" />
            <h2 id="diff-h">Changed code</h2>
            <span className="mono faint small">{rangeLabel}</span>
          </span>
          <span className="diff-totals mono">
            <span className="c-broken">−{totals.removed}</span>
            <span className="c-add">+{totals.added}</span>
            <Icon name="chevronUp" size={16} className="faint summary-arrow" />
          </span>
        </summary>
        {diff.isPending && <SkeletonLines rows={4} height={14} />}
        {diff.isError && <ErrorBanner error={diff.error} />}
        {diff.data !== undefined && files.length === 0 && <p className="soft small">No code lines changed.</p>}
        {files.length > 0 && <DiffView files={files} />}
      </details>
    </section>
  );
}

/** The verdict in plain words, under the tiles. */
export function VerdictStrip({ report }: { report: Report }) {
  const level = report.risk.level;
  const sentences = verdictSentences(report);
  return (
    <div className={`verdict level-${level}`}>
      <div className="verdict-text">
        <Icon name={level === "low" ? "checkCircle" : level === "medium" ? "warning" : "alertCircle"} size={18} />
        <p>
          <strong>{level[0].toUpperCase() + level.slice(1)} risk:</strong> {sentences.join(" ")}
        </p>
      </div>
      {report.hidden_dependencies.length > 0 && (
        <div className="verdict-key label quiet">
          <span>
            <span className="line code" aria-hidden="true" /> Read from code
          </span>
          <span>
            <span className="line runtime" aria-hidden="true" /> Runtime link
          </span>
        </div>
      )}
    </div>
  );
}

/** Details of the point picked on the radar, with a way to analyze it on its own. */
export function NodeDetail({
  report,
  name,
  onAnalyze,
  onClose,
}: {
  report: Report;
  name: string;
  onAnalyze: (name: string) => void;
  onClose: () => void;
}) {
  const s = [...report.changed, ...report.affected].find((x) => x.name === name);
  const d = report.deleted.find((x) => x.name === name);
  return (
    <div className="node-detail" role="status">
      <div className="node-detail-main">
        <div className="mono strong wrap-anywhere">{name}</div>
        {s && (
          <div className="mono small soft">
            {s.route && <span className="c-route">{s.route} · </span>}
            {s.file_path}:{s.line}
            {s.distance > 0 && ` · ${s.distance === 1 ? "1 step" : `${s.distance} steps`} away`}
            {s.confidence === "dynamic" && <span className="c-hidden"> · found only at runtime</span>}
          </div>
        )}
        {s && s.via.length > 1 && (
          <div className="mono small faint">via {s.via.map((v) => shortLabel(v)).join(" → ")}</div>
        )}
        {d && (
          <div className="mono small c-broken">
            Deleted from {fileName(d.file_path)}
            {d.still_called_by.length ? `; still called by ${d.still_called_by.map((c) => shortLabel(c)).join(", ")}` : ""}
          </div>
        )}
      </div>
      <div className="row-gap">
        {!d && (
          <button type="button" className="btn small primary" onClick={() => onAnalyze(name)}>
            Blast radius of this
          </button>
        )}
        <button type="button" className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
