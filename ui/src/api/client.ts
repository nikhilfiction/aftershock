/**
 * The only place that talks to the backend. Components use the hooks in
 * hooks.ts, never fetch directly.
 *
 * Every failure becomes an ApiError with a human message and, for 422
 * responses, a map of field name -> message for showing next to inputs.
 */

/**
 * Where the API is. By default the same server that serves this app, under
 * /api: `aftershock serve` serves both, and in development Vite forwards
 * /api to it (see vite.config.ts). Set VITE_API_URL only for an API elsewhere.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");

/** The API's full address, for messages: "/api" becomes "http://localhost:8000/api". */
export function apiAddress(): string {
  try {
    return new URL(API_URL, window.location.href).href.replace(/\/$/, "");
  } catch {
    return API_URL;
  }
}

const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }

  /** Network failures and server errors may succeed on a retry; 4xx will not. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

type ValidationItem = { loc?: (string | number)[]; msg?: string };

function normalize(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail;

  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc: ["body", "url"], msg: "..."}]
    const fields: Record<string, string> = {};
    const general: string[] = [];
    for (const item of detail as ValidationItem[]) {
      const loc = item.loc ?? [];
      const field = loc.length > 1 ? String(loc[loc.length - 1]) : "";
      const msg = (item.msg ?? "Invalid value").replace(/^Value error, /, "");
      if (field) fields[field] = msg;
      else general.push(msg);
    }
    const message = general[0] ?? (Object.keys(fields).length ? "Please fix the highlighted field." : "Invalid request.");
    return new ApiError(status, message, fields);
  }

  if (typeof detail === "string") return new ApiError(status, detail);
  if (status >= 500) return new ApiError(status, `The server had a problem (${status}). Try again in a moment.`);
  return new ApiError(status, `Request failed (${status}).`);
}

type Options = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  accept?: "json" | "text";
};

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const { method = "GET", body, signal, accept = "json" } = options;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      signal: combined,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (signal?.aborted) throw err; // the caller cancelled; not an error to show
    if (timeout.aborted) throw new ApiError(0, "The API took too long to answer. Try again.");
    throw new ApiError(0, `Can't reach the API at ${apiAddress()}. Is \`aftershock serve\` running?`);
  }

  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      /* non-JSON error body; normalize handles null */
    }
    throw normalize(response.status, parsed);
  }

  if (response.status === 204) return undefined as T;
  return (accept === "text" ? await response.text() : await response.json()) as T;
}
