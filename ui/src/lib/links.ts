/** Where links between pages go. */
import { API_URL } from "../api/client";
import type { RepoDetail, Snapshot } from "../api/types";
import { APP_VERSION } from "./format";

export const API_DOCS_URL = `${API_URL}/docs`;
export const DOCS_URL = (import.meta.env.VITE_DOCS_URL as string | undefined) || `${API_URL}/redoc`;
export const VERSION_TEXT = `Aftershock v${APP_VERSION}`;

export const isDefault = (repo: RepoDetail, s: Snapshot) => s.ref === repo.default_branch;
export const hasGit = (s: Pick<Snapshot, "commit_sha">) => s.commit_sha !== "working-tree";

/** Where a scan's "Open" goes: another branch opens compared with the default branch, like a pull request. */
export function scanLink(repo: RepoDetail, s: Snapshot): string {
  return !isDefault(repo, s) && hasGit(s)
    ? `/snapshots/${s.id}?base=${encodeURIComponent(repo.default_branch)}`
    : `/snapshots/${s.id}`;
}

/** The newest ready scan of another branch, to compare with the default one. */
export function compareTarget(repo: RepoDetail): Snapshot | undefined {
  return repo.snapshots.find((s) => s.status === "ready" && !isDefault(repo, s) && hasGit(s));
}
