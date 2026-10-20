/**
 * One scan: ask what a change would affect and read the report.
 * The question lives in the address (?fn=send_receipt or ?base=main), so a
 * report can be linked to, and Back goes to the previous one.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { ApiError } from "../api/client";
import { useBlastRadius, useRepo, useSnapshot } from "../api/hooks";
import type { BlastRequest, RepoDetail, Snapshot } from "../api/types";
import { AnalyzeBar, type FormState } from "../components/report/AnalyzeBar";
import { PhoneNav, ReportHeader, ReportSidebar, ScanCard } from "../components/report/Chrome";
import { ChangeReport, FunctionReport, Intro } from "../components/report/Reports";
import { AppFooter, TopBar } from "../components/Shell";
import { Empty, ErrorBanner, SkeletonLines, StatusChip } from "../components/ui";
import { APP_VERSION } from "../lib/format";
import { VERSION_TEXT, hasGit, isDefault } from "../lib/links";
import type { Mode } from "../lib/report";
import { INTRO_SECTIONS, changeSections, functionSections } from "../lib/sections";
import { scrollToId, useScrollSpy } from "../lib/useLayout";

const clampDepth = (n: number) => (Number.isFinite(n) ? Math.min(6, Math.max(1, Math.round(n))) : 3);

function Workbench({ snapshot, repo }: { snapshot: Snapshot; repo: RepoDetail }) {
  const [params, setParams] = useSearchParams();
  const blast = useBlastRadius(snapshot.id);
  const [asked, setAsked] = useState<{ mode: Mode; base: string } | null>(null);

  const urlFn = params.get("fn") ?? "";
  const urlBase = params.get("base") ?? "";
  const urlDepth = clampDepth(Number(params.get("depth") ?? 3));

  // another branch of a git repo opens ready to compare with the default branch
  const comparable = hasGit(snapshot) && !isDefault(repo, snapshot);
  const [form, setForm] = useState<FormState>(() => ({
    mode: urlBase || (!urlFn && comparable) ? "base" : "symbol",
    target: urlFn,
    diff: "",
    base: urlBase || (comparable ? repo.default_branch : ""),
    depth: urlDepth,
  }));

  function run(mode: Mode, body: BlastRequest) {
    setAsked({ mode, base: body.base ?? "" });
    blast.mutate(body, {
      onSuccess: () => {
        // on narrow screens the answer appears below the form; bring it into view
        if (window.matchMedia?.("(max-width: 999px)").matches) window.setTimeout(() => scrollToId("report-start"), 50);
      },
    });
  }

  // run what the address asks for, once per distinct question
  const lastRun = useRef("");
  useEffect(() => {
    const key = urlFn ? `fn:${urlFn}:${urlDepth}` : urlBase ? `base:${urlBase}:${urlDepth}` : "";
    if (!key || key === lastRun.current) return;
    lastRun.current = key;
    const mode: Mode = urlFn ? "symbol" : "base";
    setForm((f) => ({ ...f, mode, target: urlFn || f.target, base: urlBase || f.base, depth: urlDepth }));
    run(mode, urlFn ? { targets: [urlFn], depth: urlDepth } : { base: urlBase, depth: urlDepth });
    // run is stable enough here: it only reads the mutation and setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFn, urlBase, urlDepth]);

  function onRun(mode: Mode, body: BlastRequest) {
    if (mode === "diff") {
      // a diff is too long for the address; run it directly
      lastRun.current = "";
      setParams({});
      run(mode, body);
      return;
    }
    const next: Record<string, string> =
      mode === "symbol" ? { fn: body.targets![0], depth: String(body.depth) } : { base: body.base!, depth: String(body.depth) };
    const key = mode === "symbol" ? `fn:${next.fn}:${body.depth}` : `base:${next.base}:${body.depth}`;
    if (key === lastRun.current) run(mode, body); // the same question again: analyze again
    else setParams(next);
  }

  function analyzeFunction(name: string) {
    setParams({ fn: name, depth: String(form.depth) });
  }

  const analysis = blast.data;
  const sections = analysis && asked
    ? asked.mode === "symbol"
      ? functionSections(analysis.report)
      : changeSections(analysis.report)
    : INTRO_SECTIONS;
  const active = useScrollSpy(sections.map((s) => s.id));
  const phoneSections = sections.filter((s) => s.id !== "broken-h" && s.id !== "graph-h");

  return (
    <div className="report-app">
      <ReportSidebar repo={repo} snapshot={snapshot} sections={sections} active={active} />
      <div className="report-col">
        <ReportHeader repo={repo} snapshot={snapshot} />
        <main id="main" className="report-main">
          <h1 className="sr-only">
            {repo.name} / {snapshot.ref}
          </h1>
          <AnalyzeBar
            snapshot={snapshot}
            form={form}
            setForm={setForm}
            pending={blast.isPending}
            error={blast.error}
            onRun={onRun}
          />
          <ScanCard snapshot={snapshot} />
          {snapshot.error && <p className="notice warn report-note">{snapshot.error}</p>}
          <div id="report-start" className="report-body" aria-live="polite">
            {blast.isPending && (
              <div className="panel">
                <SkeletonLines rows={5} height={22} />
              </div>
            )}
            {!blast.isPending && !analysis && <Intro snapshot={snapshot} onAnalyze={analyzeFunction} />}
            {!blast.isPending && analysis && asked && (
              asked.mode === "symbol" ? (
                <FunctionReport
                  key={analysis.id}
                  analysis={analysis}
                  snapshot={snapshot}
                  repoName={repo.name}
                  mode={asked.mode}
                  base={asked.base}
                  onAnalyze={analyzeFunction}
                />
              ) : (
                <ChangeReport
                  key={analysis.id}
                  analysis={analysis}
                  snapshot={snapshot}
                  repoName={repo.name}
                  mode={asked.mode}
                  base={asked.base}
                  onAnalyze={analyzeFunction}
                />
              )
            )}
          </div>
        </main>
        <div className="only-desktop">
          <AppFooter
            items={[
              VERSION_TEXT,
              `Scan: ${snapshot.symbol_count} symbols, ${snapshot.edge_count} links`,
              ...(analysis
                ? [
                    <span key="risk" className={`c-${analysis.risk_level}`}>
                      Risk: {analysis.risk_level} ({analysis.risk_score})
                    </span>,
                  ]
                : []),
            ]}
          />
        </div>
        <div className="phone-bottom only-phone">
          {analysis && <PhoneNav sections={phoneSections} active={active} />}
          <div className="phone-foot mono">
            <span>
              Aftershock v{APP_VERSION} • {snapshot.symbol_count} symbols
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A scan that is not ready yet, or failed. */
function Waiting({ snapshot, repo }: { snapshot: Snapshot; repo: RepoDetail | undefined }) {
  return (
    <div className="app">
      <TopBar />
      <main id="main" className="wrap page-pad stack">
        <nav className="crumbs label" aria-label="Breadcrumb">
          <Link to="/">Repositories</Link>
          <span aria-hidden="true">/</span>
          {repo ? <Link to={`/repos/${repo.id}`}>{repo.name}</Link> : <span>…</span>}
          <span aria-hidden="true">/</span>
          <span aria-current="page" className="c-primary">
            {snapshot.ref}
          </span>
        </nav>
        <h1 className="page-title">{snapshot.ref}</h1>
        <div className="row-gap">
          <StatusChip snapshot={snapshot} />
        </div>
        {snapshot.error && <p className={`notice ${snapshot.status === "failed" ? "error" : "warn"}`}>{snapshot.error}</p>}
        {snapshot.status !== "failed" && (
          <div className="panel" aria-live="polite">
            <Empty title="Scanning…">This page updates by itself when the scan is ready.</Empty>
          </div>
        )}
      </main>
      <AppFooter items={[VERSION_TEXT]} />
    </div>
  );
}

export default function SnapshotPage() {
  const id = Number(useParams().snapshotId);
  const snapshot = useSnapshot(id);
  const repo = useRepo(snapshot.data?.repo_id ?? 0);
  const s = snapshot.data;

  if (snapshot.isError || repo.isError) {
    const err = snapshot.error ?? repo.error;
    const notFound = err instanceof ApiError && err.status === 404;
    return (
      <div className="app">
        <TopBar />
        <main id="main" className="wrap page-pad">
          {notFound ? (
            <div className="panel">
              <Empty title="Scan not found">
                <Link to="/">Back to repositories</Link>
              </Empty>
            </div>
          ) : (
            <ErrorBanner error={err} onRetry={() => (snapshot.isError ? snapshot.refetch() : repo.refetch())} />
          )}
        </main>
      </div>
    );
  }
  if (!s || (s.status === "ready" && !repo.data)) {
    return (
      <div className="app">
        <TopBar />
        <main id="main" className="wrap page-pad">
          <div className="panel">
            <SkeletonLines rows={5} height={24} />
          </div>
        </main>
      </div>
    );
  }
  if (s.status !== "ready") return <Waiting snapshot={s} repo={repo.data} />;
  return <Workbench snapshot={s} repo={repo.data!} />;
}
