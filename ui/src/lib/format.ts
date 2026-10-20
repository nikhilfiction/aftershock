/** Small formatting helpers shared by pages and components. */

export const APP_VERSION = "1.0.0";

export function shortName(qualified: string): string {
  return qualified.split(".").pop() ?? qualified;
}

/** app.services.hooks.send_receipt -> send_receipt; a method keeps its class: Repo.find */
export function shortLabel(name: string, kind = "function"): string {
  const parts = name.split(".");
  return kind === "method" ? parts.slice(-2).join(".") : parts[parts.length - 1];
}

/** The last two parts: app.services.orders.list_orders -> orders.list_orders */
export function moduleAndName(name: string): string {
  return name.split(".").slice(-2).join(".");
}

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A commit id for display; plain folders have none. */
export function shortSha(sha: string | null | undefined, length = 7): string {
  if (!sha || sha === "working-tree") return "";
  return sha.slice(0, length);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** "GET /orders/" -> { method: "GET", path: "/orders/" } */
export function splitRoute(route: string): { method: string; path: string } {
  const [method, ...rest] = route.trim().split(" ");
  return { method: method ?? "", path: rest.join(" ") };
}

/** Puts text on the clipboard; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Saves text as a file through a temporary link. */
export function downloadText(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const LANGUAGE_NAMES: Record<string, string> = { python: "Python", typescript: "TypeScript", javascript: "JavaScript" };

/** ["python", "typescript"] -> "Python + TypeScript"; "" before a scan has said. */
export function languageLabel(languages: string[] | undefined): string {
  return (languages ?? []).map((l) => LANGUAGE_NAMES[l] ?? l).join(" + ");
}

/** What read the code: Python's ast module, the TypeScript compiler, or both (before a scan: both). */
export function parserLabel(languages: string[] | undefined): string {
  if (!languages?.length) return "Python ast + TypeScript compiler";
  const langs = languages;
  const parts = [];
  if (langs.includes("python")) parts.push("Python ast");
  if (langs.some((l) => l !== "python")) parts.push("TypeScript compiler");
  return parts.join(" + ");
}

/** What ran the tests when tracing: pytest, the JS test runner, or both (before a scan: the choices). */
export function tracerLabel(languages: string[] | undefined, testRunner: string | undefined): string {
  if (!languages?.length) return "pytest, Vitest or Jest";
  const langs = languages;
  const parts = [];
  if (langs.includes("python")) parts.push("pytest");
  if (langs.some((l) => l !== "python")) parts.push(testRunner || "the package.json test runner");
  return parts.join(" + ");
}
