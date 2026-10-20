/**
 * What the report screens show, worked out from a report's numbers. Kept free
 * of React so it is tested on its own.
 */
import type { AffectedSymbol, DeletedSymbol, Report } from "../api/types";
import { moduleAndName, plural, shortLabel } from "./format";

/** How the user asked: one function, a pasted diff, or a branch compared with a base. */
export type Mode = "symbol" | "diff" | "base";

export type Tone = "low" | "medium" | "high" | "broken" | "depends" | "routes" | "hidden" | "tests" | "warn";

export type Tile = {
  key: string;
  label: string;
  tone: Tone;
  value: number;
  unit: string;
  note: string;
  target?: string;        // the id of the heading the tile jumps to
  badge?: string;         // e.g. HIGH next to the risk score
  bar?: number;           // 0-100, drawn under the number
};

export const levelWord = (level: string) => level.toUpperCase();

/** Deleted functions that something still calls: a guaranteed crash. */
export function brokenDeletions(r: Report): DeletedSymbol[] {
  return r.deleted.filter((d) => d.still_called_by.length > 0);
}

export function routesOf(r: Report): AffectedSymbol[] {
  return [...r.changed, ...r.affected].filter((s) => s.kind === "route");
}

/** The deleted function a symbol's chain ends in, if its way to the change runs through one. */
export function breaksThrough(r: Report, s: AffectedSymbol): DeletedSymbol | undefined {
  const last = s.via[s.via.length - 1];
  return brokenDeletions(r).find((d) => d.name === last);
}

/** "GET /orders/" when the scanner read the route's path, else the function name. */
export function routeTitle(s: { name: string; route?: string }): string {
  return s.route || shortLabel(s.name);
}

/** One line on how a route reaches the change. */
export function routeNote(r: Report, s: AffectedSymbol): string {
  const deleted = breaksThrough(r, s);
  if (deleted) {
    return s.via.length <= 2
      ? `Calls deleted ${shortLabel(deleted.name)}`
      : `Reaches deleted ${shortLabel(deleted.name)} in ${s.via.length - 1} steps`;
  }
  if (s.distance === 0) return "Changed itself";
  const next = s.via[1] ? shortLabel(s.via[1]) : "the change";
  return s.distance === 1 ? `Calls ${next} directly` : `${s.distance} steps via ${next}`;
}

/** "all in tests/test_shop.py", or how many files the tests live in. */
export function testsNote(tests: string[]): string {
  if (tests.length === 0) return "no test reaches it";
  const files = new Set(tests.map((t) => t.split("::")[0]));
  return files.size === 1 ? `all in ${[...files][0]}` : `in ${files.size} files`;
}

/** The test's own name: tests/test_shop.py::test_x -> test_x, tests/shop.test.ts::orders lists mine -> orders lists mine */
export const testName = (id: string) => id.split("::").slice(1).join("::") || id;

/** The commands that run just the tests to run, one per test runner. Reports
 * saved before the API sent a command get the pytest one. */
export function testCommands(r: Report): string[] {
  if (r.test_command) return r.test_command.split("\n").filter(Boolean);
  return r.tests_to_run.length ? [`pytest ${r.tests_to_run.join(" ")}`] : [];
}

/** "pytest", "vitest", "jest", or "pytest + vitest" for a project with both. */
export function testRunnerName(r: Report): string {
  const names = testCommands(r).map((c) => {
    const words = c.split(" ");
    return words[0] === "npx" ? words[1] : words[0] === "node" ? "node --test" : words[0];
  });
  return [...new Set(names)].join(" + ") || "tests";
}

export function tilesFor(r: Report): Tile[] {
  const routes = routesOf(r);
  const direct = r.affected.filter((s) => s.distance === 1).length;
  const further = r.affected.length - direct;
  const farthest = Math.max(0, ...r.affected.map((s) => s.distance));
  const broken = brokenDeletions(r);
  const hidden = r.hidden_dependencies.length;
  const tests = r.tests_to_run.length;

  const tiles: Tile[] = [
    {
      key: "risk",
      label: "Risk score",
      tone: r.risk.level as Tone,
      value: r.risk.score,
      unit: "/ 100",
      note: "",
      badge: levelWord(r.risk.level),
      bar: r.risk.score,
    },
  ];
  if (broken.length) {
    tiles.push({
      key: "broken",
      label: "Will break",
      tone: "broken",
      value: broken.length,
      unit: "deleted but called",
      note: moduleAndName(broken[0].name) + (broken.length > 1 ? ` +${broken.length - 1} more` : ""),
      target: "broken-h",
    });
  }
  tiles.push(
    {
      key: "depends",
      label: "Depends on it",
      tone: "depends",
      value: r.affected.length,
      unit: `${plural(r.affected.length, "caller", "callers")}${r.affected.length ? ` (${direct} direct)` : ""}`,
      note:
        r.affected.length === 0
          ? "nothing calls it"
          : further
            ? `${further} more, up to ${farthest} steps away`
            : "all call it directly",
      target: "radar-h",
    },
    {
      key: "routes",
      label: "API routes",
      tone: "routes",
      value: routes.length,
      unit: plural(routes.length, "endpoint", "endpoints"),
      note: routes.length ? routes.map(routeTitle).join(", ") : "none run this code",
      target: routes.length ? "routes-h" : undefined,
    },
  );
  if (hidden) {
    tiles.push({
      key: "hidden",
      label: "Hidden",
      tone: "hidden",
      value: hidden,
      unit: "found at runtime",
      note: "invisible when reading the code",
      target: "hidden-h",
    });
  }
  tiles.push({
    key: "tests",
    label: "Tests to run",
    tone: tests ? "tests" : "warn",
    value: tests,
    unit: plural(tests, "reaches this change", "reach this change"),
    note: testsNote(r.tests_to_run),
    target: "tests-h",
  });
  return tiles;
}

export type ScorePart = { key: string; label: string; points: number };

const PART_LABELS: Record<string, string> = {
  broken: "Deleted but still called",
  routes: "API routes",
  spread: "Code that depends on it",
  untested: "Changed code no test reaches",
};

/** The risk score's parts, biggest first, leaving out the ones that added nothing. */
export function scoreParts(r: Report): ScorePart[] {
  return Object.entries(r.risk.parts)
    .filter(([, points]) => points > 0)
    .map(([key, points]) => ({ key, label: PART_LABELS[key] ?? key, points }))
    .sort((a, b) => b.points - a.points);
}

/** The files a report touches, and how: for marking them in the file tree. */
export type FileMark = "deleted" | "changed" | "route" | "depends";

export function fileMarks(r: Report): Map<string, FileMark> {
  const marks = new Map<string, FileMark>();
  const rank: Record<FileMark, number> = { deleted: 4, changed: 3, route: 2, depends: 1 };
  const mark = (path: string, m: FileMark) => {
    const old = marks.get(path);
    if (!old || rank[m] > rank[old]) marks.set(path, m);
  };
  for (const s of r.affected) mark(s.file_path, s.kind === "route" ? "route" : "depends");
  for (const s of r.changed) mark(s.file_path, "changed");
  for (const d of brokenDeletions(r)) mark(d.file_path, "deleted");
  return marks;
}

export const FILE_MARK_TEXT: Record<FileMark, string> = {
  deleted: "A deleted function here is still called",
  changed: "Changed in this comparison",
  route: "An API route here runs the changed code",
  depends: "Code here depends on the change",
};

