/** The frame of the report page: sidebar, top bar, the phone's scan card and bottom tabs. */
import { Link } from "react-router";

import type { RepoDetail, Snapshot } from "../../api/types";
import { shortSha } from "../../lib/format";
import { scrollToId } from "../../lib/useLayout";
import type { Section } from "../../lib/sections";
import { Icon } from "../Icon";
import { AccountMenu, ApiStatus, Brand } from "../Shell";

function jump(e: React.MouseEvent, id: string) {
  e.preventDefault();
  scrollToId(id);
}

export function ReportSidebar({
  repo,
  snapshot,
  sections,
  active,
}: {
  repo: RepoDetail;
  snapshot: Snapshot;
  sections: Section[];
  active: string | null;
}) {
  const sha = shortSha(snapshot.commit_sha);
  return (
    <aside className="side only-wide" aria-label="Report sections">
      <div className="side-inner">
      <div>
        <div className="side-brand">
          <Brand />
        </div>
        <div className="side-nav">
          <div className="label quiet">On this report</div>
          <nav aria-label="On this report">
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined} onClick={(e) => jump(e, s.id)}>
                    <Icon name={s.icon} size={18} stroke={1.8} />
                    <span>{s.label}</span>
                  </a>
                </li>
              ))}
              <li>
                <Link to={`/repos/${repo.id}`}>
                  <Icon name="arrowLeft" size={18} stroke={1.8} />
                  <span>Back to {repo.name}</span>
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </div>
      <div className="side-foot">
        <div className="label quiet">Repository</div>
        <div className="mono">
          {repo.name} / {snapshot.ref}
        </div>
        <div className="label quiet">{sha ? `Commit ${sha}` : "Folder on disk"}</div>
      </div>
      </div>
    </aside>
  );
}

export function ReportHeader({ repo, snapshot }: { repo: RepoDetail; snapshot: Snapshot }) {
  const sha = shortSha(snapshot.commit_sha);
  return (
    <header className="report-top">
      <nav className="top-crumbs mono only-desktop" aria-label="Breadcrumb">
        <Icon name="folder" size={18} stroke={1.8} className="faint" />
        <Link to={`/repos/${repo.id}`}>{repo.name}</Link>
        <span className="faint" aria-hidden="true">
          /
        </span>
        <span aria-current="page" className="c-primary">
          {snapshot.ref}
        </span>
      </nav>
      <div className="phone-brand only-phone">
        <Link to="/" className="phone-mark" aria-label="Aftershock: all repositories">
          <Icon name="radar" size={18} stroke={1.8} />
        </Link>
        <span className="phone-crumbs mono">
          <span className="phone-product">Aftershock</span>
          <span className="faint" aria-hidden="true">
            /
          </span>
          <Link to={`/repos/${repo.id}`} className="c-primary phone-repo">
            {repo.name}
          </Link>
        </span>
      </div>
      <div className="report-top-right">
        <span className="only-desktop">
          <ApiStatus />
        </span>
        <span className="only-phone">
          <ApiStatus short />
        </span>
        <span className="commit-chip mono only-desktop">
          <Icon name="commit" size={16} />
          {sha ? `git#${sha}` : "folder on disk"}
        </span>
        <AccountMenu />
      </div>
    </header>
  );
}

/** The phone's card under the form: which scan this is. */
export function ScanCard({ snapshot }: { snapshot: Snapshot }) {
  const sha = shortSha(snapshot.commit_sha);
  return (
    <section className="scan-card only-phone" aria-label="Scan">
      <div className="scan-card-top">
        <span className="scan-card-ref">
          <span className="scan-ref">{snapshot.ref}</span>
          {sha && <span className="sha">{sha}</span>}
        </span>
        <span className="scan-ready label">
          <span className="dot" aria-hidden="true" /> {snapshot.status === "ready" ? "READY" : snapshot.status.toUpperCase()}
        </span>
      </div>
      <div className="mono small soft scan-card-facts">
        <span>{snapshot.symbol_count} symbols</span>
        <span aria-hidden="true">•</span>
        <span>{snapshot.edge_count} links</span>
        <span aria-hidden="true">•</span>
        {snapshot.has_dynamic ? <span className="c-medium strong">runtime data</span> : <span>code only</span>}
      </div>
    </section>
  );
}

export function PhoneNav({ sections, active }: { sections: Section[]; active: string | null }) {
  if (!sections.length) return null;
  return (
    <nav className="phone-nav only-phone" aria-label="Jump to">
      {sections.slice(0, 4).map((s) => (
        <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined} onClick={(e) => jump(e, s.id)}>
          <Icon name={s.icon} size={20} stroke={1.8} />
          <span>{s.short}</span>
        </a>
      ))}
    </nav>
  );
}
