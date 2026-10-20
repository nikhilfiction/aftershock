import { Fragment, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { ApiError } from "../api/client";
import { useDeleteRepo, useHealth, useRepo, useStartScan, useStats } from "../api/hooks";
import type { RepoDetail, Snapshot } from "../api/types";
import { Icon } from "../components/Icon";
import { AppFooter, TopBar } from "../components/Shell";
import { CopyButton, Empty, ErrorBanner, SkeletonLines, StatusChip } from "../components/ui";
import { languageLabel, parserLabel, plural, shortSha, timeAgo, tracerLabel } from "../lib/format";
import { VERSION_TEXT, compareTarget, hasGit, isDefault, scanLink } from "../lib/links";

function ScanForm({ repo }: { repo: RepoDetail }) {
  const scan = useStartScan(repo.id);
  const [ref, setRef] = useState(repo.default_branch === "HEAD" ? "" : repo.default_branch);
  const [dynamic, setDynamic] = useState(false);
  const fieldErrors = scan.error instanceof ApiError ? scan.error.fieldErrors : {};

  function submit(e: FormEvent) {
    e.preventDefault();
    if (scan.isPending) return;
    scan.mutate({ ref: ref.trim() || null, dynamic });
  }

  return (
    <section className="panel scan-panel" aria-labelledby="scan-h">
      <div className="stack">
        <div className="panel-head">
          <div className="panel-title">
            <Icon name="flask" size={18} className="c-primary" />
            <h2 id="scan-h">Initiate AST scan</h2>
          </div>
          <span className="label quiet">
            <span className="dot c-strong" aria-hidden="true" /> Runs in the background
          </span>
        </div>

        <form onSubmit={submit} noValidate className="stack">
          <div className="field">
            <label htmlFor="scan-ref" className="label-row">
              <span className="label">Branch, commit SHA or tag</span>
              <span className="mono faint small">default: {repo.default_branch}</span>
            </label>
            <div className="input-row">
              <div className={`git-input${fieldErrors.ref ? " invalid" : ""}`}>
                <span className="affix" aria-hidden="true">
                  git:(
                </span>
                <input
                  id="scan-ref"
                  className="bare-input mono"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder={repo.default_branch === "HEAD" ? "main or feature" : repo.default_branch}
                  spellCheck={false}
                  aria-invalid={Boolean(fieldErrors.ref)}
                  aria-describedby={fieldErrors.ref ? "scan-ref-error" : undefined}
                />
                <span className="affix" aria-hidden="true">
                  )
                </span>
              </div>
              <button type="submit" className="btn primary tall" disabled={scan.isPending}>
                <Icon name="radar" size={16} />
                {scan.isPending ? "Starting…" : "Start scan"}
              </button>
            </div>
            {fieldErrors.ref && (
              <p id="scan-ref-error" className="field-error" role="alert">
                {fieldErrors.ref}
              </p>
            )}
          </div>

          <div className="check-panel">
            <input id="scan-trace" type="checkbox" checked={dynamic} onChange={(e) => setDynamic(e.target.checked)} />
            <div>
              <label htmlFor="scan-trace" className="check-title">
                Run the test suite to find hidden dynamic dependencies
              </label>
              <p className="check-text">
                Records every real function call while the tests run (pytest for Python; Vitest, Jest or Mocha for
                JavaScript and TypeScript), so it catches functions called by name, event listeners, framework callbacks
                and methods whose type is only known at runtime.{" "}
                <span className="label c-medium">Runs this repo's code: only for code you trust</span>
              </p>
            </div>
          </div>

          <details className="settings">
            <summary>
              <span className="settings-title">
                <Icon name="sliders" size={16} className="faint" />
                Repository settings
              </span>
              <Icon name="chevronDown" size={16} className="faint settings-arrow" />
            </summary>
            <dl className="settings-list mono">
              <div>
                <dt>subfolder:</dt>
                <dd className="c-primary">{repo.subdir || "(whole repository)"}</dd>
              </div>
              <div>
                <dt>default_branch:</dt>
                <dd>{repo.default_branch}</dd>
              </div>
              <div>
                <dt>follow_depth:</dt>
                <dd>3 steps (set per question)</dd>
              </div>
            </dl>
          </details>

          {scan.error && Object.keys(fieldErrors).length === 0 ? <ErrorBanner error={scan.error} /> : null}
          {scan.isSuccess && (
            <p className="notice info" role="status">
              Started scanning {scan.data.snapshot.ref}. It shows up in the table below when ready.
            </p>
          )}
        </form>
      </div>
      <div className="panel-foot label quiet">
        <span>
          Parser: <span className="soft">{parserLabel(lastReady(repo)?.languages)}</span>
        </span>
        <span>
          Graph cache: <span className="soft">memory, Redis, database</span>
        </span>
      </div>
    </section>
  );
}

function StatusPanel({ repo, base }: { repo: RepoDetail; base: Snapshot | undefined }) {
  const stats = useStats(base?.id ?? 0);
  const other = repo.snapshots.find((s) => s.status === "ready" && base && s.ref !== base.ref);
  const s = stats.data;

  if (!base) {
    return (
      <section className="panel status-panel" aria-labelledby="status-h">
        <h2 id="status-h" className="label">
          Latest scan
        </h2>
        <Empty title="No ready scan yet">Start a scan to build the dependency graph. It usually takes a few seconds.</Empty>
      </section>
    );
  }
  const confirmedShare = s && s.read_from_code ? (100 * s.confirmed) / s.read_from_code : 0;
  return (
    <section className="panel status-panel" aria-labelledby="status-h">
      <div className="stack-sm">
        <div className="panel-head">
          <h2 id="status-h" className="label">
            {isDefault(repo, base) ? `Default branch: ${base.ref}` : `Latest scan: ${base.ref}`}
          </h2>
          <span className="chip c-primary">READY</span>
        </div>
        {stats.isPending && <SkeletonLines rows={3} />}
        {stats.isError && <ErrorBanner error={stats.error} onRetry={() => stats.refetch()} />}
        {s && (
          <>
            <div className="stat-grid">
              <div className="stat-box">
                <span className="label quiet">Symbols</span>
                <span className="stat-value">{s.symbols}</span>
                <span className="stat-note c-primary">{other ? `${other.symbol_count} on ${other.ref}` : `${s.files} files`}</span>
              </div>
              <div className="stat-box">
                <span className="label quiet">Call links</span>
                <span className="stat-value">{s.links}</span>
                <span className="stat-note">{other ? `${other.edge_count} on ${other.ref}` : `${s.unresolved_calls} unresolved`}</span>
              </div>
              <div className="stat-box">
                <span className="label quiet">Seen at runtime</span>
                <span className="stat-value">{base.has_dynamic ? s.seen_running : "–"}</span>
                <span className={`stat-note${s.runtime_only ? " c-medium" : ""}`}>
                  {base.has_dynamic ? `${s.runtime_only} only at runtime` : "tests not traced"}
                </span>
              </div>
              <div className="stat-box">
                <span className="label quiet">API routes</span>
                <span className="stat-value">{s.routes}</span>
                <span className="stat-note">
                  {s.tests} {plural(s.tests, "test", "tests")} in the repo
                </span>
              </div>
            </div>
            {base.has_dynamic && (
              <div className="stat-box">
                <div className="bar-head label">
                  <span className="soft">Calls confirmed by the tests</span>
                  <span className="bar-count">
                    {s.confirmed} of {s.read_from_code}
                  </span>
                </div>
                <div
                  className="meter"
                  role="img"
                  aria-label={`${s.confirmed} of ${s.read_from_code} calls read from the code were confirmed by running the tests`}
                >
                  <div style={{ width: `${confirmedShare}%` }} />
                </div>
                <div className="bar-foot mono">
                  <span>read from code</span>
                  <span>seen running</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="panel-foot label quiet">
        <Icon name="checkCircle" size={16} className="c-primary" />
        <span>
          {base.has_dynamic
            ? `Tests traced with ${tracerLabel(base.languages, base.test_runner)}`
            : "Read from the code only; tick the test option to trace"}
        </span>
      </div>
    </section>
  );
}

/** The newest scan that finished; its languages describe the repository. */
function lastReady(repo: RepoDetail): Snapshot | undefined {
  return repo.snapshots.find((s) => s.status === "ready");
}

function ScansTable({ repo }: { repo: RepoDetail }) {
  const [filter, setFilter] = useState("");
  const health = useHealth();
  const needle = filter.trim().toLowerCase();
  const rows = repo.snapshots.filter((s) => !needle || s.ref.toLowerCase().includes(needle) || (s.commit_sha ?? "").startsWith(needle));
  const newestReady = repo.snapshots.find((s) => s.status === "ready");
  const target = compareTarget(repo);

  return (
    <section className="panel flush scans" aria-labelledby="scans-h">
      <div className="scans-head">
        <div className="panel-title">
          <Icon name="graph" size={20} stroke={1.8} className="soft" />
          <h2 id="scans-h">
            Scans &amp; cached AST graphs{" "}
            <span className="label quiet">
              ({repo.snapshots.length} {plural(repo.snapshots.length, "scan", "scans")})
            </span>
          </h2>
        </div>
        {repo.snapshots.length > 1 && (
          <label className="filter">
            <Icon name="search" size={14} className="faint" />
            <span className="sr-only">Filter scans</span>
            <input
              className="bare-input mono"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter branch or SHA..."
            />
          </label>
        )}
      </div>

      {repo.snapshots.length === 0 ? (
        <Empty title="Not scanned yet">Start a scan to build the dependency graph. It usually takes a few seconds.</Empty>
      ) : (
        <div className="table-wrap" aria-live="polite">
          <table className="scan-table">
            <thead>
              <tr>
                <th scope="col">Branch / ref</th>
                <th scope="col">Commit SHA</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Symbols
                </th>
                <th scope="col" className="num">
                  Call links
                </th>
                <th scope="col">Scanned</th>
                <th scope="col" className="num">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Fragment key={s.id}>
                  <tr className={s.error ? "has-note" : undefined}>
                    <td>
                      <div className="ref-cell">
                        <Icon
                          name={isDefault(repo, s) ? "commit" : "branch"}
                          size={18}
                          className={isDefault(repo, s) ? "c-primary" : "c-medium"}
                        />
                        <div>
                          <div className="ref-name">
                            {s.ref}
                            {isDefault(repo, s) && <span className="mini-tag">Default</span>}
                          </div>
                          <div className="ref-sub">{isDefault(repo, s) ? "default branch" : hasGit(s) ? "branch or commit" : "folder on disk"}</div>
                        </div>
                      </div>
                    </td>
                    <td>{hasGit(s) && s.commit_sha ? <span className="sha">{shortSha(s.commit_sha, 12)}</span> : <span className="faint">–</span>}</td>
                    <td>
                      <StatusChip snapshot={s} />
                    </td>
                    <td className="num strong">{s.status === "ready" ? s.symbol_count : ""}</td>
                    <td className="num strong">{s.status === "ready" ? s.edge_count : ""}</td>
                    <td className="when">{timeAgo(s.scanned_at ?? s.created_at)}</td>
                    <td className="num">
                      {s.status === "ready" && (
                        <Link className={`btn small${s === newestReady ? " primary" : ""}`} to={scanLink(repo, s)}>
                          Open blast radius
                          <Icon name="arrowRight" size={14} />
                        </Link>
                      )}
                    </td>
                  </tr>
                  {s.error && (
                    <tr className="note-row">
                      <td colSpan={7}>
                        <p className={`notice ${s.status === "failed" ? "error" : "warn"} row-note`}>{s.error}</p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="faint">
                    No scan matches “{filter}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="scans-foot label quiet">
        <div className="foot-facts">
          <span>
            Storage: <span className="soft">{health.data?.database === "postgresql" ? "PostgreSQL" : "SQLite"}</span>
          </span>
          <span className="faint" aria-hidden="true">
            |
          </span>
          <span>
            Scan queue: <span className="soft">{health.data?.queue === "redis" ? "Redis worker" : "inside the API"}</span>
          </span>
        </div>
        <div className="foot-facts">
          <span className="soft">
            Showing {rows.length} of {repo.snapshots.length} {plural(repo.snapshots.length, "scan", "scans")}
          </span>
          {target && (
            <Link to={scanLink(repo, target)} className="text-link">
              Compare branches <Icon name="swap" size={14} />
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function DeleteRepo({ repo }: { repo: RepoDetail }) {
  const navigate = useNavigate();
  const remove = useDeleteRepo();
  const [confirming, setConfirming] = useState(false);
  const n = repo.snapshots.length;

  return (
    <div className="panel delete-strip">
      <p className="soft">
        {confirming
          ? `Delete ${repo.name} and ${n === 1 ? "its scan" : `all ${n} scans`}? Your code is not touched.`
          : `Deleting removes the repository and ${n === 0 ? "its settings" : n === 1 ? "its scan" : `all ${n} scans`} from Aftershock. Your code is not touched.`}
      </p>
      {!confirming ? (
        <button type="button" className="btn danger-text" onClick={() => setConfirming(true)}>
          <Icon name="trash" size={16} />
          Delete repository
        </button>
      ) : (
        <div className="row-gap" role="group" aria-label="Confirm delete">
          <button
            type="button"
            className="btn danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate(repo.id, { onSuccess: () => navigate("/") })}
            autoFocus
          >
            {remove.isPending ? "Deleting…" : "Yes, delete"}
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </div>
      )}
      {remove.error ? <ErrorBanner error={remove.error} /> : null}
    </div>
  );
}

function RepoStrip({ repo, base }: { repo: RepoDetail; base: Snapshot | undefined }) {
  const stats = useStats(base?.id ?? 0);
  const newestReady = repo.snapshots.find((s) => s.status === "ready");
  const target = compareTarget(repo);
  const remote = repo.url.startsWith("https://");
  const s = stats.data;
  return (
    <div className="repo-strip">
      <div className="wrap repo-strip-inner">
        <div className="repo-strip-id">
          <nav className="crumbs label" aria-label="Breadcrumb">
            <Link to="/">Repositories</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="c-primary strong">
              {repo.name}
            </span>
            <span className="chip plain">{remote ? "git remote" : "local folder"}</span>
          </nav>
          <div className="repo-title-row">
            <h1>
              {repo.name}
              {newestReady && <span className="index-tag">Active index</span>}
            </h1>
            <div className="path-chip mono">
              <span className="wrap-anywhere">
                {repo.url}
                {repo.subdir && `/${repo.subdir}`}
              </span>
              <CopyButton
                getText={() => repo.url + (repo.subdir ? `/${repo.subdir}` : "")}
                label=""
                icon="copy"
                className="icon-btn"
                ariaLabel="Copy the path"
              />
            </div>
          </div>
          <div className="repo-facts-line label">
            {languageLabel(base?.languages) && (
              <span>
                <span className="dot c-primary" aria-hidden="true" />
                {languageLabel(base?.languages)}
              </span>
            )}
            {s && (
              <>
                <span className="sep" aria-hidden="true">
                  •
                </span>
                <span>
                  <Icon name="fork" size={14} className="faint" />
                  API routes: {s.routes}
                </span>
                <span className="sep" aria-hidden="true">
                  •
                </span>
                <span>
                  {s.files} {plural(s.files, "file", "files")}
                </span>
                <span className="sep" aria-hidden="true">
                  •
                </span>
                <span className="faint">
                  Tests:{" "}
                  <span className="c-primary">
                    {s.tests}
                    {base?.has_dynamic ? `, traced with ${tracerLabel(base.languages, base.test_runner)}` : ""}
                  </span>
                </span>
              </>
            )}
          </div>
        </div>
        <div className="row-gap">
          {target ? (
            <Link to={scanLink(repo, target)} className="btn">
              <Icon name="swap" size={16} className="faint" />
              Compare branches
            </Link>
          ) : (
            <button
              type="button"
              className="btn"
              disabled
              title={`Scan a second branch of a git repository to compare it with ${repo.default_branch}`}
            >
              <Icon name="swap" size={16} className="faint" />
              Compare branches
            </button>
          )}
          {newestReady && (
            <Link to={`/snapshots/${newestReady.id}`} className="btn primary">
              <Icon name="play" size={16} />
              Open latest scan
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RepoPage() {
  const id = Number(useParams().repoId);
  const { data: repo, isPending, isError, error, refetch } = useRepo(id);

  if (isPending || isError) {
    const notFound = isError && error instanceof ApiError && error.status === 404;
    return (
      <div className="app">
        <TopBar />
        <main id="main" className="wrap page-pad">
          {isPending && (
            <div className="panel">
              <SkeletonLines rows={4} height={24} />
            </div>
          )}
          {notFound && (
            <div className="panel">
              <Empty title="Repository not found">
                It may have been deleted. <Link to="/">Back to repositories</Link>
              </Empty>
            </div>
          )}
          {isError && !notFound && <ErrorBanner error={error} onRetry={() => refetch()} />}
        </main>
      </div>
    );
  }

  const ready = repo.snapshots.filter((s) => s.status === "ready");
  const base = ready.find((s) => isDefault(repo, s)) ?? ready[0];

  return (
    <div className="app">
      <TopBar
        right={
          <span className="git-ref mono">
            <Icon name="prompt" size={16} />
            git:({repo.default_branch})
          </span>
        }
      />
      <main id="main" className="repo-page">
        <RepoStrip repo={repo} base={base} />
        <div className="wrap repo-body">
          <div className="repo-top">
            <ScanForm repo={repo} />
            <StatusPanel repo={repo} base={base} />
          </div>
          <ScansTable repo={repo} />
          <DeleteRepo repo={repo} />
        </div>
      </main>
      <AppFooter
        items={[
          VERSION_TEXT,
          `Parser: ${parserLabel(base?.languages)}`,
          <span key="tracing" className="soft">
            Tracing: {tracerLabel(base?.languages, base?.test_runner)}
          </span>,
        ]}
      />
    </div>
  );
}
