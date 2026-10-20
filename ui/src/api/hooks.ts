/**
 * Server state, through TanStack Query: caching, polling, retries and
 * cache updates after mutations live here.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { request } from "./client";
import type {
  Analysis,
  BlastRequest,
  Graph,
  Health,
  Repo,
  RepoCreate,
  RepoDetail,
  ScanQueued,
  ScanRequest,
  Snapshot,
  SnapshotStats,
  Source,
  SymbolHit,
} from "./types";
import { WORKING } from "./types";

const POLL_MS = 1500;

export const keys = {
  health: ["health"] as const,
  repos: ["repos"] as const,
  repo: (id: number) => ["repo", id] as const,
  snapshot: (id: number) => ["snapshot", id] as const,
  stats: (id: number) => ["stats", id] as const,
  symbols: (id: number, q: string) => ["symbols", id, q] as const,
  kind: (id: number, kind: string) => ["kind", id, kind] as const,
  source: (id: number, path: string, start: number, end: number) => ["source", id, path, start, end] as const,
  graph: (id: number, focus: string | null, depth: number) => ["graph", id, focus, depth] as const,
  diff: (analysisId: number) => ["diff", analysisId] as const,
};

const busy = (snapshots: Snapshot[] | undefined) => Boolean(snapshots?.some((s) => WORKING.includes(s.status)));

/** Is the API up? Checked every 15 seconds for the status light in the header. */
export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => request<Health>("/health", { signal }),
    refetchInterval: 15_000,
    retry: false,
  });
}

/** Every repository with its scans; polls while any of them is still scanning. */
export function useRepos() {
  return useQuery({
    queryKey: keys.repos,
    queryFn: ({ signal }) => request<RepoDetail[]>("/repos", { signal }),
    refetchInterval: (query) => (query.state.data?.some((r) => busy(r.snapshots)) ? POLL_MS : false),
  });
}

/** Polls while any snapshot is still being scanned. */
export function useRepo(id: number) {
  return useQuery({
    queryKey: keys.repo(id),
    queryFn: ({ signal }) => request<RepoDetail>(`/repos/${id}`, { signal }),
    enabled: id > 0,
    refetchInterval: (query) => (busy(query.state.data?.snapshots) ? POLL_MS : false),
  });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RepoCreate) => request<Repo>("/repos", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.repos }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<void>(`/repos/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: keys.repo(id) });
      return qc.invalidateQueries({ queryKey: keys.repos });
    },
  });
}

export function useStartScan(repoId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ScanRequest) =>
      request<ScanQueued>(`/repos/${repoId}/scan`, { method: "POST", body }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.repo(repoId) }),
        qc.invalidateQueries({ queryKey: keys.repos }),
      ]),
  });
}

/** Polls until the snapshot is ready or failed. */
export function useSnapshot(id: number) {
  return useQuery({
    queryKey: keys.snapshot(id),
    queryFn: ({ signal }) => request<Snapshot>(`/snapshots/${id}`, { signal }),
    refetchInterval: (query) => (query.state.data && WORKING.includes(query.state.data.status) ? POLL_MS : false),
  });
}

/** Counts for one ready scan. Pass 0 while there is none yet. */
export function useStats(snapshotId: number) {
  return useQuery({
    queryKey: keys.stats(snapshotId),
    queryFn: ({ signal }) => request<SnapshotStats>(`/snapshots/${snapshotId}/stats`, { signal }),
    enabled: snapshotId > 0,
    staleTime: Infinity, // a ready snapshot never changes
  });
}

export function useSymbols(snapshotId: number, q: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.symbols(snapshotId, q),
    queryFn: ({ signal }) =>
      request<SymbolHit[]>(`/snapshots/${snapshotId}/symbols?q=${encodeURIComponent(q)}&limit=12`, { signal }),
    enabled: enabled && q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** Every symbol of one kind: "module" gives the files, "route" the API routes. */
export function useSymbolsOfKind(snapshotId: number, kind: "module" | "route", enabled = true) {
  return useQuery({
    queryKey: keys.kind(snapshotId, kind),
    queryFn: ({ signal }) =>
      request<SymbolHit[]>(`/snapshots/${snapshotId}/symbols?kind=${kind}&include_tests=true&limit=500`, { signal }),
    enabled: enabled && snapshotId > 0,
    staleTime: Infinity,
  });
}

/** A few lines of a scanned file. */
export function useSource(snapshotId: number, path: string, start: number, end: number, enabled = true) {
  return useQuery({
    queryKey: keys.source(snapshotId, path, start, end),
    queryFn: ({ signal }) =>
      request<Source>(
        `/snapshots/${snapshotId}/source?${new URLSearchParams({ path, start: String(start), end: String(end) })}`,
        { signal },
      ),
    enabled: enabled && snapshotId > 0 && start > 0 && Boolean(path),
    staleTime: Infinity,
    retry: false, // a 404 (file gone) will not fix itself
  });
}

export function useBlastRadius(snapshotId: number) {
  return useMutation({
    mutationFn: (body: BlastRequest) =>
      request<Analysis>(`/snapshots/${snapshotId}/blast-radius`, { method: "POST", body }),
  });
}

/** The diff an analysis was made from (pasted, or the branch's changes). */
export function useAnalysisDiff(analysisId: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.diff(analysisId),
    queryFn: ({ signal }) => request<string>(`/analyses/${analysisId}/diff`, { signal, accept: "text" }),
    enabled: enabled && analysisId > 0,
    staleTime: Infinity,
    retry: false,
  });
}

export function useGraph(snapshotId: number, focus: string | null, depth: number) {
  const params = new URLSearchParams({ depth: String(depth) });
  if (focus) params.set("focus", focus);
  return useQuery({
    queryKey: keys.graph(snapshotId, focus, depth),
    queryFn: ({ signal }) => request<Graph>(`/snapshots/${snapshotId}/graph?${params}`, { signal }),
    placeholderData: keepPreviousData,
    staleTime: Infinity, // a ready snapshot's graph never changes
  });
}

export function fetchMarkdown(analysisId: number): Promise<string> {
  return request<string>(`/analyses/${analysisId}?format=markdown`, { accept: "text" });
}
