/**
 * What to analyze: a function, a pasted diff, or this branch compared with
 * another. A bar across the top on a desktop, a card on a phone.
 */
import type { Dispatch, FormEvent, SetStateAction } from "react";

import { ApiError } from "../../api/client";
import type { BlastRequest, Snapshot } from "../../api/types";
import { shortSha } from "../../lib/format";
import { hasGit } from "../../lib/links";
import type { Mode } from "../../lib/report";
import { Icon } from "../Icon";
import { SymbolSearch } from "../SymbolSearch";
import { ErrorBanner } from "../ui";

export type FormState = { mode: Mode; target: string; diff: string; base: string; depth: number };

const MODES: { id: Mode; label: string }[] = [
  { id: "symbol", label: "A function" },
  { id: "diff", label: "A diff" },
  { id: "base", label: "Compared to a branch" },
];

type Props = {
  snapshot: Snapshot;
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  pending: boolean;
  error: unknown;
  onRun: (mode: Mode, body: BlastRequest) => void;
};

export function AnalyzeBar({ snapshot, form, setForm, pending, error, onRun }: Props) {
  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};
  const generalError = error && Object.keys(fieldErrors).length === 0 ? error : null;
  const noGit = !hasGit(snapshot);
  const { mode, target, diff, base, depth } = form;
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const ready = mode === "symbol" ? Boolean(target) : mode === "diff" ? Boolean(diff.trim()) : Boolean(base.trim()) && !noGit;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending || !ready) return;
    if (mode === "symbol") onRun(mode, { targets: [target], depth });
    else if (mode === "diff") onRun(mode, { diff, depth });
    else onRun(mode, { base: base.trim(), depth });
  }

  const baseError = fieldErrors.base;
  return (
    <form className="analyze" onSubmit={submit} noValidate aria-label="What to analyze">
      <div className="analyze-title only-phone">
        <span className="panel-title">
          <Icon name="sliders" size={16} className="c-primary" />
          <span className="label strong-label">Impact configuration</span>
        </span>
        <span className="mono faint small">scope: callers</span>
      </div>

      <div className="analyze-main">
        <div className="tabs" role="tablist" aria-label="What to analyze">
          {MODES.map((m) => (
            <button
              key={m.id}
              id={`ask-tab-${m.id}`}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              aria-controls="ask-panel"
              onClick={() => set({ mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="analyze-inputs" id="ask-panel" role="tabpanel" aria-labelledby={`ask-tab-${mode}`}>
          {mode === "symbol" && (
            <SymbolSearch
              snapshotId={snapshot.id}
              value={target}
              onChange={(t) => set({ target: t })}
              error={fieldErrors.targets}
            />
          )}
          {mode === "base" && (
            <div className="base-row">
              <div className={`bar-field${baseError ? " invalid" : ""}`}>
                <label htmlFor="ask-base">
                  <span className="prefix" aria-hidden="true">
                    base:
                  </span>
                  <span className="field-name">Base branch</span>
                </label>
                <input
                  id="ask-base"
                  className="bare-input mono"
                  value={base}
                  onChange={(e) => set({ base: e.target.value })}
                  placeholder="main"
                  disabled={noGit}
                  spellCheck={false}
                  aria-invalid={Boolean(baseError)}
                  aria-describedby={baseError ? "ask-base-error" : noGit ? "ask-base-hint" : undefined}
                />
              </div>
              <Icon name="arrowRight" size={14} className="faint only-desktop" />
              <span className="target-ref mono only-desktop">
                <span className="faint">target:</span> <span className="ref-chip">{snapshot.ref}</span>
                {shortSha(snapshot.commit_sha) && <span className="faint small"> (rev: {shortSha(snapshot.commit_sha)})</span>}
              </span>
            </div>
          )}
          {mode === "diff" && <span className="mono faint small diff-note">Paste a unified diff below</span>}
        </div>

        <div className="bar-field depth">
          <label htmlFor="ask-depth">
            <span className="prefix" aria-hidden="true">
              depth:
            </span>
            <span className="field-name">How far to follow</span>
          </label>
          <select id="ask-depth" className="bare-select mono" value={depth} onChange={(e) => set({ depth: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "1 step (direct)" : `${d} steps`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="analyze-side">
        <span className="scan-facts label quiet only-desktop">
          <span className="chip">
            {snapshot.symbol_count} symbols, {snapshot.edge_count} links
          </span>
        </span>
        <button type="submit" className="btn primary" disabled={pending || !ready}>
          {pending ? <span className="spinner" aria-hidden="true" /> : <Icon name="radar" size={16} />}
          {pending ? "Analyzing…" : "Show blast radius"}
        </button>
      </div>

      {mode === "diff" && (
        <div className="analyze-diff field">
          <label htmlFor="ask-diff" className="label">
            Diff
          </label>
          <textarea
            id="ask-diff"
            className="textarea mono"
            value={diff}
            onChange={(e) => set({ diff: e.target.value })}
            placeholder={"diff --git a/app/auth.py b/app/auth.py\n--- a/app/auth.py\n+++ b/app/auth.py\n@@ -12 +12 @@ ..."}
            spellCheck={false}
            aria-invalid={Boolean(fieldErrors.diff)}
            aria-describedby={fieldErrors.diff ? "ask-diff-error ask-diff-hint" : "ask-diff-hint"}
          />
          <span id="ask-diff-hint" className="hint">
            Paste the output of <code>git diff</code> or <code>git diff main</code>.
          </span>
          {fieldErrors.diff && (
            <p id="ask-diff-error" className="field-error" role="alert">
              {fieldErrors.diff}
            </p>
          )}
        </div>
      )}

      {mode === "base" && noGit && (
        <p id="ask-base-hint" className="analyze-note">
          This scan is of a plain folder with no git history, so there is nothing to compare. Paste a diff instead.
        </p>
      )}
      {mode === "base" && baseError && (
        <p id="ask-base-error" className="field-error analyze-note" role="alert">
          {baseError}
        </p>
      )}
      {generalError ? (
        <div className="analyze-note">
          <ErrorBanner error={generalError} />
        </div>
      ) : null}
    </form>
  );
}
