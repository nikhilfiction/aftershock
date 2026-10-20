import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";

import { ApiError } from "../api/client";
import { useCreateRepo, useRepos, useStartScan, useStats } from "../api/hooks";
import type { RepoDetail } from "../api/types";
import { WORKING } from "../api/types";
import { Icon } from "../components/Icon";
import { AppFooter, TopBar } from "../components/Shell";
import { Empty, ErrorBanner, SkeletonLines, StatusChip } from "../components/ui";
import { languageLabel, plural, timeAgo, tracerLabel } from "../lib/format";
import { VERSION_TEXT } from "../lib/links";

function AddRepoForm() {
  const navigate = useNavigate();
  const create = useCreateRepo();
  const [url, setUrl] = useState("");
  const [subdir, setSubdir] = useState("");
  const [branch, setBranch] = useState("");

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const generalError = create.error && Object.keys(fieldErrors).length === 0 ? create.error : null;
  const optionsHaveError = Boolean(fieldErrors.subdir || fieldErrors.default_branch);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (create.isPending) return; // no double submit, even before React re-renders the disabled button
    create.mutate(
      { url: url.trim(), subdir: subdir.trim(), default_branch: branch.trim() || "HEAD" },
      { onSuccess: (repo) => navigate(`/repos/${repo.id}`) },
    );
  }

  const urlError = fieldErrors.url;
  return (
    <section className="panel add-repo" aria-labelledby="add-h">
      <div className="panel-head ruled">
        <div className="panel-title">
          <span className="lamp" aria-hidden="true" />
          <h2 id="add-h" className="caps">
            Add a repository
          </h2>
        </div>
        <div className="source-kinds" aria-hidden="true">
          <span className="kind-tag">GIT_CLONE</span>
          <span className="faint">/</span>
          <span className="kind-tag">LOCAL_FS</span>
        </div>
      </div>

      <form onSubmit={submit} noValidate className="stack">
        <div className="field">
          <label htmlFor="repo-url">Git URL or folder path</label>
          <div className="input-row">
            <div className={`input-shell${urlError ? " invalid" : ""}`}>
              <Icon name="console" size={16} stroke={1.8} className="input-icon" />
              <input
                id="repo-url"
                className="bare-input mono"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/you/project.git or ~/Desktop/aftershock/examples/shop_api"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(urlError)}
                aria-describedby={urlError ? "repo-url-error repo-url-hint" : "repo-url-hint"}
              />
            </div>
            <button type="submit" className="btn add-btn" disabled={create.isPending || !url.trim()}>
              {create.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={14} />}
              {create.isPending ? "Adding…" : "Add repository"}
            </button>
          </div>
          <p id="repo-url-hint" className="hint mono">
            Accepts an https:// git clone URL, or the absolute path of a folder on the machine running the API.
          </p>
          {urlError && (
            <p id="repo-url-error" className="field-error" role="alert">
              {urlError}
            </p>
          )}
        </div>

        <details className="more" open={optionsHaveError || undefined}>
          <summary>
            <Icon name="chevronRight" size={14} className="more-arrow" />
            Monorepo settings or specific default branch
          </summary>
          <div className="more-grid">
            <div className="field">
              <label htmlFor="repo-subdir" className="mono small-label">
                Subfolder to scan (optional)
              </label>
              <input
                id="repo-subdir"
                className="input mono"
                value={subdir}
                onChange={(e) => setSubdir(e.target.value)}
                placeholder="services/shop-api"
                aria-invalid={Boolean(fieldErrors.subdir)}
              />
              {fieldErrors.subdir && <p className="field-error" role="alert">{fieldErrors.subdir}</p>}
            </div>
            <div className="field">
              <label htmlFor="repo-branch" className="mono small-label">
                Default branch
              </label>
              <input
                id="repo-branch"
                className="input mono"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                aria-invalid={Boolean(fieldErrors.default_branch)}
              />
              {fieldErrors.default_branch && (
                <p className="field-error" role="alert">
                  {fieldErrors.default_branch}
                </p>
              )}
            </div>
          </div>
        </details>

        {generalError && <ErrorBanner error={generalError} />}
      </form>
    </section>
  );
}

function RepoCard({ repo }: { repo: RepoDetail }) {
  const latest = repo.snapshots[0];
  const ready = repo.snapshots.find((s) => s.status === "ready");
  const stats = useStats(ready?.id ?? 0);
  const rescan = useStartScan(repo.id);
  const working = repo.snapshots.some((s) => WORKING.includes(s.status));
  const refs = [...new Set(repo.snapshots.map((s) => s.ref))];
  const tracedScan = repo.snapshots.find((s) => s.has_dynamic);
  const traced = Boolean(tracedScan);
  const scanned = repo.snapshots.find((s) => s.status === "ready");

  return (
    <li className="panel repo-card">
      <div className="repo-card-main">
        <span className="repo-mark" aria-hidden="true">
          <Icon name="target" size={20} stroke={1.75} />
          {ready && <span className="repo-mark-dot" />}
        </span>
        <div className="repo-card-id">
          <div className="repo-card-title">
            <Link to={`/repos/${repo.id}`} className="repo-name">
              {repo.name}
            </Link>
            {latest ? <StatusChip snapshot={latest} /> : <span className="status-chip idle">Not scanned yet</span>}
            {stats.data && stats.data.routes > 0 && (
              <span className="kind-tag">
                {stats.data.routes} API {plural(stats.data.routes, "ROUTE", "ROUTES")}
              </span>
            )}
          </div>
          <div className="repo-path mono">
            <Icon name="folder" size={12} stroke={1.8} />
            <span title={repo.url + (repo.subdir ? `/${repo.subdir}` : "")}>
              {repo.url}
              {repo.subdir && `/${repo.subdir}`}
            </span>
          </div>
        </div>
      </div>

      <dl className="repo-facts mono">
        <div>
          <dt>Scans</dt>
          <dd>
            {repo.snapshots.length}{" "}
            {refs.length > 0 && <span className="faint small">({refs.slice(0, 3).join(", ")})</span>}
          </dd>
        </div>
        <div>
          <dt>Last scanned</dt>
          <dd>{latest ? timeAgo(latest.scanned_at ?? latest.created_at) : "never"}</dd>
        </div>
        <div>
          <dt>Analysis</dt>
          <dd>
            <span className={traced ? "lamp-text on" : "lamp-text"} aria-hidden="true">
              ●
            </span>{" "}
            {scanned && <span className="faint">{languageLabel(scanned.languages)} · </span>}
            <span>
              {tracedScan
                ? `Call graph + ${tracerLabel(tracedScan.languages, tracedScan.test_runner)} trace`
                : "Call graph from the code"}
            </span>
          </dd>
        </div>
      </dl>

      <div className="repo-actions">
        <button
          type="button"
          className="btn mono"
          disabled={rescan.isPending || working}
          onClick={() =>
            rescan.mutate({
              ref: repo.default_branch === "HEAD" ? null : repo.default_branch,
              dynamic: latest?.want_dynamic ?? false,
            })
          }
          title={`Scan ${repo.default_branch === "HEAD" ? "the default branch" : repo.default_branch} again`}
        >
          <Icon name="rescan" size={14} />
          {working ? "Scanning…" : "Rescan"}
        </button>
        <Link to={`/repos/${repo.id}`} className="btn strong">
          Open repository
          <Icon name="chevronRight" size={12} />
        </Link>
      </div>
      {rescan.error ? <ErrorBanner error={rescan.error} /> : null}
    </li>
  );
}

const CAPABILITIES = [
  {
    icon: "chip" as const,
    tone: "c-primary",
    title: "Call graphs from the code",
    text: "Reads every function, class, import and call without running anything: Python through its syntax tree, JavaScript and TypeScript through the TypeScript compiler, which also follows method calls through types.",
    foot: "Engines: Python ast, TypeScript compiler",
  },
  {
    icon: "console" as const,
    tone: "c-route",
    title: "Route surface mapping",
    text: "Links HTTP endpoints (FastAPI, Flask, Express, Fastify, NestJS, Next.js) to the changed functions, so you see which API routes a change can break.",
    foot: "Output: affected routes per change",
  },
  {
    icon: "checkCircle" as const,
    tone: "c-medium",
    title: "Targeted test runs",
    text: "Lists only the tests that reach the changed code, with the pytest, Vitest or Jest command that runs just those, instead of the whole suite.",
    foot: "Targeting: commit diff blast radius",
  },
];

export default function ReposPage() {
  const { data, isPending, isError, error, refetch } = useRepos();
  const scans = data?.reduce((n, r) => n + r.snapshots.length, 0) ?? 0;

  return (
    <div className="app">
      <TopBar />
      <main id="main" className="hub">
        <section className="hub-head">
          <div className="hub-intro">
            <div className="hub-tags mono" aria-hidden="true">
              <span className="kind-tag">INDEX_MANAGER</span>
              <span className="faint">•</span>
              <span>STATIC_AST_PARSER</span>
            </div>
            <h1>Repositories</h1>
            <p className="lede">
              Scan a Python, JavaScript or TypeScript codebase once, then ask what any change would affect: the functions
              that depend on it, the API routes that run it, and the tests worth running.
            </p>
          </div>
          {data && (
            <div className="hub-stats mono">
              <span className="stat-chip">
                <span className="faint">REPOS:</span> <strong>{data.length} active</strong>
              </span>
              <span className="stat-chip">
                <span className="faint">INDEXED:</span> <strong>{scans} {plural(scans, "scan", "scans")}</strong>
              </span>
            </div>
          )}
        </section>

        <AddRepoForm />

        <section aria-labelledby="list-h" className="stack">
          <div className="list-head">
            <div className="panel-title">
              <h2 id="list-h">Your repositories</h2>
              {data && <span className="count">{data.length}</span>}
            </div>
            {data && data.length > 0 && (
              <span className="faint mono small">
                Showing {data.length} of {data.length} {plural(data.length, "repository", "repositories")}
              </span>
            )}
          </div>
          {isPending && (
            <div className="panel">
              <SkeletonLines rows={3} />
            </div>
          )}
          {isError && <ErrorBanner error={error} onRetry={() => refetch()} />}
          {data && data.length === 0 && (
            <div className="panel">
              <Empty title="No repositories yet">
                To try it out, add the example app that ships with this project: the full path to{" "}
                <code>examples/shop_api</code>.
              </Empty>
            </div>
          )}
          {data && data.length > 0 && (
            <ul className="repo-list">
              {data.map((repo) => (
                <RepoCard key={repo.id} repo={repo} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="caps-h" className="caps-section">
          <h2 id="caps-h" className="caps-title mono">
            <Icon name="bolt" size={14} />
            Aftershock static analysis core
          </h2>
          <div className="caps-grid">
            {CAPABILITIES.map((c) => (
              <div key={c.title} className="panel cap-card">
                <h3 className={c.tone}>
                  <Icon name={c.icon} size={16} />
                  <span>{c.title}</span>
                </h3>
                <p>{c.text}</p>
                <span className="faint mono tiny">{c.foot}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
      <AppFooter items={[VERSION_TEXT, "Static call graphs & runtime test tracing for Python, JavaScript and TypeScript"]} />
    </div>
  );
}
