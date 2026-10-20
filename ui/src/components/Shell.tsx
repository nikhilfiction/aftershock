/** The frame around every page: the bar at the top, the API light, the account button and the footer. */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { apiAddress } from "../api/client";
import { useHealth } from "../api/hooks";
import { APP_VERSION } from "../lib/format";
import { API_DOCS_URL, DOCS_URL } from "../lib/links";
import { Icon } from "./Icon";


/** The rings mark and the name. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className={`brand${compact ? " compact" : ""}`}>
      <Icon name="radar" size={20} stroke={1.8} />
      <span className="brand-name">Aftershock</span>
      {!compact && <span className="brand-version">v{APP_VERSION.split(".").slice(0, 2).join(".")}</span>}
    </Link>
  );
}

/** "API: Ready" when the backend answers, "API: Offline" when it does not. */
export function ApiStatus({ short = false }: { short?: boolean }) {
  const health = useHealth();
  const state = health.isPending ? "checking" : health.data?.ok ? "ready" : "offline";
  const word = { checking: "Checking", ready: short ? "Online" : "Ready", offline: "Offline" }[state];
  return (
    <span
      className={`api-status ${state}`}
      role="status"
      title={state === "offline" ? `No answer from ${apiAddress()}. Is \`aftershock serve\` running?` : apiAddress()}
    >
      <span className="dot" aria-hidden="true" />
      {short ? <span className="api-word">{word}</span> : <span>API: <span className="api-word">{word}</span></span>}
    </span>
  );
}

/** The light-blue person button. There are no accounts: it says so, and links to the API. */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const box = useRef<HTMLDivElement>(null);
  const health = useHealth();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="account" ref={box}>
      <button
        type="button"
        className="avatar"
        aria-label="Account"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="person" size={18} />
      </button>
      {open && (
        <div id={panelId} className="account-panel" role="region" aria-label="Account">
          <p className="account-title">Local workspace</p>
          <p className="account-text">Aftershock runs on your own machine, so there is nothing to sign in to.</p>
          <dl className="account-facts">
            <div>
              <dt>API</dt>
              <dd className="mono">{apiAddress()}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{health.data?.ok ? `ready, ${health.data.queue} scans` : health.isPending ? "checking" : "offline"}</dd>
            </div>
          </dl>
          <a className="account-link" href={API_DOCS_URL} target="_blank" rel="noreferrer">
            Open the API docs <Icon name="external" size={12} />
          </a>
        </div>
      )}
    </div>
  );
}

/** The bar on the Repositories and repository pages. */
export function TopBar({ right }: { right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-left">
          <Brand />
          <span className="divider" aria-hidden="true" />
          <nav aria-label="Main" className="topnav">
            <NavLink to="/" end>
              Repositories
            </NavLink>
            <a href={API_DOCS_URL} target="_blank" rel="noreferrer">
              API docs
            </a>
          </nav>
        </div>
        <div className="topbar-right">
          <ApiStatus />
          {right}
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

/** The thin bar at the bottom: a few facts on the left, links on the right. */
export function AppFooter({ items }: { items: ReactNode[] }) {
  return (
    <footer className="app-footer">
      <div className="footer-facts">
        {items.map((item, i) => (
          <span key={i} className="footer-item">
            {item}
          </span>
        ))}
      </div>
      <nav aria-label="Footer" className="footer-links">
        <a href={DOCS_URL} target="_blank" rel="noreferrer">
          [Documentation]
        </a>
        <a href={API_DOCS_URL} target="_blank" rel="noreferrer">
          [API docs]
        </a>
      </nav>
    </footer>
  );
}
