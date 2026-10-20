/** Small building blocks used across pages. */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ApiError } from "../api/client";
import type { Snapshot } from "../api/types";
import { copyText } from "../lib/format";
import { Icon, type IconName } from "./Icon";

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message : "Something unexpected happened. Try reloading the page.";
  const canRetry = onRetry && (!(error instanceof ApiError) || error.retryable);
  return (
    <div className="notice error" role="alert">
      <Icon name="alertCircle" size={16} />
      <span>{message}</span>
      {canRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function SkeletonLines({ rows = 3, height = 18 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  queued: "Waiting",
  scanning: "Scanning code",
  tracing: "Running tests",
  ready: "Ready",
  failed: "Failed",
};

/** A dot and a word: Ready, Scanning code, Failed... with "with runtime data" when the tests ran. */
export function StatusChip({ snapshot, compact = false }: { snapshot: Pick<Snapshot, "status" | "has_dynamic">; compact?: boolean }) {
  const { status } = snapshot;
  const tone = status === "ready" ? "ready" : status === "failed" ? "failed" : "working";
  return (
    <span className={`status-chip ${tone}`}>
      {tone === "working" ? <span className="spinner" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
      <span className="status-word">{STATUS_TEXT[status] ?? status}</span>
      {status === "ready" && snapshot.has_dynamic && !compact && <span className="status-more">with runtime data</span>}
    </span>
  );
}

type FieldProps = {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => ReactNode;
};

/** A labelled input with hint and error text wired up for screen readers. */
export function Field({ id, label, hint, error, className, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {hint && (
        <span id={hintId} className="hint">
          {hint}
        </span>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Copies text; `getText` may be async (e.g. fetch the Markdown first). */
export function CopyButton({
  getText,
  label,
  className = "btn small",
  icon,
  ariaLabel,
}: {
  getText: () => string | Promise<string>;
  label: string;
  className?: string;
  icon?: IconName;
  ariaLabel?: string;
}) {
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    setState("working");
    let ok = false;
    try {
      ok = await copyText(await getText());
    } catch {
      ok = false;
    }
    setState(ok ? "done" : "failed");
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      disabled={state === "working"}
      aria-label={ariaLabel ? (state === "done" ? "Copied" : ariaLabel) : undefined}
      title={ariaLabel}
    >
      {icon && <Icon name={state === "done" ? "check" : icon} size={14} />}
      {label && (state === "done" ? "Copied" : state === "failed" ? "Couldn't copy" : label)}
      <span className="sr-only" aria-live="polite">
        {state === "done" ? "Copied" : state === "failed" ? "Couldn't copy" : ""}
      </span>
    </button>
  );
}

/** A small "No results" or "Nothing here yet" block. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}
