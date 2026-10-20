/**
 * Short names for the generated API types. Regenerate schema.d.ts after
 * changing the backend:  npm run gen:api   (with `aftershock serve` running)
 */
import type { components } from "./schema";

type S = components["schemas"];

export type Repo = S["RepoOut"];
export type RepoDetail = S["RepoDetail"];
export type RepoCreate = S["RepoCreate"];
export type Snapshot = S["SnapshotOut"];
export type ScanRequest = S["ScanRequest"];
export type ScanQueued = S["ScanQueued"];
export type SymbolHit = S["SymbolOut"];
export type SnapshotStats = S["SnapshotStats"];
export type Source = S["SourceOut"];
export type BlastRequest = S["BlastRequest"];
export type Analysis = S["AnalysisOut"];
export type Report = S["Report"];
export type AffectedSymbol = S["AffectedSymbol"];
export type DeletedSymbol = S["DeletedSymbolOut"];
export type CallSite = S["CallSite"];
export type Graph = S["GraphOut"];
export type GraphNode = S["GraphNode"];
export type GraphEdge = S["GraphEdge"];

/** GET /health has no schema in the API docs, so its shape is written here. */
export type Health = {
  ok: boolean;
  version?: string;
  queue: "redis" | "in-process";
  database?: "sqlite" | "postgresql";
  demo?: boolean;      // a public demo: the example repos are set up and scanned on every start
};

export type SnapshotStatus = "queued" | "scanning" | "tracing" | "ready" | "failed";

export const WORKING: readonly string[] = ["queued", "scanning", "tracing"];
