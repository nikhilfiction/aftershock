/**
 * The right-hand column of a single function's report: who calls it (with the
 * line of code that does), the tests to run, and the changed function itself.
 */
import { useSource, useStats } from "../../api/hooks";
import type { AffectedSymbol, Analysis, Report } from "../../api/types";
import { dedent, headerLines, highlight, languageOf } from "../../lib/code";
import { fileName, plural, shortLabel } from "../../lib/format";
import { brokenDeletions, testCommands, testRunnerName } from "../../lib/report";
import { Icon } from "../Icon";
import { CopyButton } from "../ui";
import { ReportActions } from "./panels";

function Code({ lines, mark, path }: { lines: string[]; mark?: number; path: string }) {
  const language = languageOf(path);
  return (
    <pre className="snippet mono">
      {dedent(lines).map((l, i) => (
        <div key={i} className={i === mark ? "snippet-line marked" : "snippet-line"}>
          {highlight(l, language)}
          {"\n"}
        </div>
      ))}
    </pre>
  );
}

function CallerCard({ snapshotId, s }: { snapshotId: number; s: AffectedSymbol }) {
  const line = s.call_line;
  const src = useSource(snapshotId, s.file_path, Math.max(1, line - 1), line, line > 0);
  const tone = s.kind === "route" ? "route" : s.confidence === "dynamic" ? "hidden" : "plain";
  const next = s.via[1] ? shortLabel(s.via[1]) : "it";
  const how =
    s.confidence === "dynamic"
      ? "Seen only while the tests ran"
      : s.confidence === "both"
        ? "In the code, and seen while the tests ran"
        : "Read from the code";
  return (
    <li className={`caller-card ${tone}`}>
      <div className="caller-top">
        <span className="caller-name mono">{s.name}</span>
        <span className={`step-chip ${tone}`}>{s.distance === 1 ? "1 step" : `${s.distance} steps`} away</span>
      </div>
      <p className="caller-how mono">
        {s.route && <span className="c-route">{s.route} · </span>}
        {line > 0 ? (
          <>
            Calls {next} at {fileName(s.file_path)}:{line}
          </>
        ) : (
          <>Calls {next}</>
        )}
        <span className="faint"> · {how}</span>
      </p>
      {src.data && src.data.lines.length > 0 && <Code lines={src.data.lines} mark={src.data.lines.length - 1} path={s.file_path} />}
    </li>
  );
}

const MAX_CALLERS = 6;

export function CallersSection({ snapshotId, report }: { snapshotId: number; report: Report }) {
  const target = report.changed[0];
  const name = target ? shortLabel(target.name, target.kind) : "the change";
  const hidden = report.hidden_dependencies.length;
  const all = report.affected;
  const allHidden = all.length > 0 && hidden === all.length;
  const shown = all.slice(0, MAX_CALLERS);
  return (
    <section className="side-section" aria-labelledby="hidden-h">
      <div className="side-head">
        <h2 id="hidden-h" className="label quiet">
          {allHidden ? "Hidden callers found" : "Who calls it"}
        </h2>
        <span className={`mono small${hidden ? " c-hidden" : " faint"}`}>
          {all.length} {plural(all.length, "function", "functions")}
        </span>
      </div>
      <p className="soft small">
        {all.length === 0
          ? `Nothing calls ${name}.`
          : allHidden
            ? `Reading the code finds nothing that calls ${name}. These calls were recorded while the tests ran:`
            : hidden
              ? `${hidden} of them ${plural(hidden, "was", "were")} found only while the tests ran.`
              : `Everything that ends up calling ${name}, closest first.`}
      </p>
      <ul className="caller-list">
        {shown.map((s) => (
          <CallerCard key={s.name} snapshotId={snapshotId} s={s} />
        ))}
      </ul>
      {all.length > shown.length && (
        <p className="faint mono small">
          +{all.length - shown.length} more on the radar
        </p>
      )}
    </section>
  );
}

/** One command, one argument per line: `$ pytest \` then each test id. */
function TerminalCommand({ command }: { command: string }) {
  const [program, args] = splitCommand(command);
  return (
    <>
      <div className="terminal-prompt">
        <span className="c-primary strong">$</span> {program}
        {args.length > 0 ? " \\" : ""}
      </div>
      {args.map((arg, i) => (
        <div key={`${arg}-${i}`} className="terminal-arg">
          {arg}
          {i < args.length - 1 ? " \\" : ""}
        </div>
      ))}
    </>
  );
}

/** "npx vitest run a.ts -t 'x y'" -> ["npx vitest run", ["a.ts", "-t 'x y'"]] */
function splitCommand(command: string): [string, string[]] {
  const parts = command.match(/'[^']*'|\S+/g) ?? [];
  let n = 1;
  if (parts[0] === "npx") n = parts[1] === "vitest" && parts[2] === "run" ? 3 : 2;
  else if (parts[0] === "node" && parts[1] === "--test") n = 2;
  const args: string[] = [];
  for (const part of parts.slice(n)) {
    const prev = args[args.length - 1];
    // keep a flag and its value together: -t '^(...)$'
    if (prev !== undefined && prev.startsWith("-") && !prev.includes(" ") && !part.startsWith("-")) {
      args[args.length - 1] = `${prev} ${part}`;
    } else {
      args.push(part);
    }
  }
  return [parts.slice(0, n).join(" "), args];
}

export function TestsTerminal({ snapshotId, report }: { snapshotId: number; report: Report }) {
  const stats = useStats(snapshotId);
  const tests = report.tests_to_run;
  const total = stats.data?.tests;
  const commands = testCommands(report);
  return (
    <section className="side-section" aria-labelledby="tests-h">
      <div className="side-head">
        <div className="panel-title">
          <Icon name="prompt" size={18} className="c-primary" />
          <h2 id="tests-h" className="label quiet">
            Tests to run
          </h2>
        </div>
        {tests.length > 0 && (
          <CopyButton
            label="Copy test command"
            icon="copy"
            className="btn small"
            getText={() => commands.join("\n")}
          />
        )}
      </div>
      {tests.length === 0 ? (
        <p className="soft small">No test reaches the changed code. Consider adding one before merging.</p>
      ) : (
        <>
          <p className="soft small">
            No need to run the whole suite. Only {plural(tests.length, "this", "these")} {tests.length}
            {total ? ` of the ${total}` : ""} {plural(tests.length, "test reaches", "tests reach")} the changed code:
          </p>
          <div className="terminal mono" role="group" aria-label={`${testRunnerName(report)} command`}>
            {commands.map((command) => (
              <TerminalCommand key={command} command={command} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function ChangedFunction({ snapshotId, report }: { snapshotId: number; report: Report }) {
  const s = report.changed[0];
  const src = useSource(snapshotId, s?.file_path ?? "", s?.line ?? 0, (s?.line ?? 0) + 9, Boolean(s));
  const broken = brokenDeletions(report);
  if (!s) return null;
  const lines = src.data ? headerLines(src.data.lines, languageOf(s?.file_path ?? "")) : [];
  return (
    <section className="side-section grow" aria-labelledby="sig-h">
      <div className="side-head">
        <h2 id="sig-h" className="label quiet">
          Changed {s.kind === "route" ? "route" : s.kind === "class" ? "class" : "function"}
        </h2>
        <span className="mono c-primary small">
          {fileName(s.file_path)}:{s.line}
        </span>
      </div>
      <div className="sig-box">
        {lines.length > 0 ? <Code lines={lines} path={s.file_path} /> : <div className="mono strong wrap-anywhere">{s.name}</div>}
        {src.isError && <p className="faint small">The file is not on disk any more, so the code can't be shown.</p>}
        <div className={`sig-foot label ${broken.length ? "c-broken" : "c-low"}`}>
          <Icon name={broken.length ? "alertCircle" : "checkCircle"} size={14} />
          {broken.length ? (
            <span>
              {broken.length} deleted {plural(broken.length, "function is", "functions are")} still called
            </span>
          ) : (
            <span>
              Nothing will break <span className="faint">• no deleted function is still called</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** The whole right-hand column. */
export function Inspector({ snapshotId, analysis }: { snapshotId: number; analysis: Analysis }) {
  const r = analysis.report;
  return (
    <aside className="inspector" aria-label="Findings">
      <div className="inspector-head">
        <div className="panel-title">
          <Icon name="eye" size={20} stroke={1.8} className="c-hidden" />
          <span className="inspector-title">{r.hidden_dependencies.length ? "Runtime findings" : "Findings"}</span>
        </div>
        <span className="chip plain">Inspector</span>
      </div>
      <CallersSection snapshotId={snapshotId} report={r} />
      <TestsTerminal snapshotId={snapshotId} report={r} />
      <ChangedFunction snapshotId={snapshotId} report={r} />
      <div className="side-actions">
        <ReportActions analysis={analysis} primary />
      </div>
    </aside>
  );
}
