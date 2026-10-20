import { describe, expect, it } from "vitest";

import type { Report } from "../api/types";
import { dedent, headerLines, highlight, languageOf } from "../lib/code";
import { diffTotals, parseDiff } from "../lib/diff";
import { treeRows } from "../lib/files";
import { layoutRadar, overlaps } from "../lib/radarLayout";
import { languageLabel, parserLabel, tracerLabel } from "../lib/format";
import { fileMarks, routeNote, scoreParts, testCommands, testRunnerName, testsNote, tilesFor } from "../lib/report";
import { verdictSentences } from "../lib/verdict";
import { analysis, branchAnalysis, branchDiff } from "./fixtures";

const report = analysis.report;
const branch = branchAnalysis.report;
const dist = (x: number, y: number, cx: number, cy: number) => Math.hypot(x - cx, y - cy);

describe("radar layout", () => {
  const map = layoutRadar(report, 600, 600);
  const at = (id: string) => map.nodes.find((n) => n.id === id)!;

  it("puts a single change in the middle, its name just above it", () => {
    const c = at("app.services.hooks.send_receipt");
    expect([c.x, c.y]).toEqual([map.center.x, map.center.y]);
    expect(c.by).toBeLessThan(map.center.y);
  });

  it("puts each dependent on the ring for its distance", () => {
    for (const s of report.affected) {
      const n = at(s.name);
      const ring = map.rings.find((r) => r.distance === s.distance)!;
      expect(dist(n.x, n.y, map.center.x, map.center.y)).toBeCloseTo(ring.r, 5);
    }
    expect(map.rings.map((r) => r.label)).toEqual(["1 STEP · DIRECT", "2 STEPS", "3 STEPS"]);
  });

  it("points a lone chain straight down, with the route's path in its box", () => {
    const chain = ["app.services.hooks.run_hook", "app.services.orders.create_order", "app.routes.orders.place_order"];
    for (const id of chain) expect(Math.cos(at(id).angle)).toBeCloseTo(0, 6);
    expect(at("app.routes.orders.place_order")).toMatchObject({ kind: "route", text: "POST /orders/", caption: "place_order" });
  });

  it("dashes links found only at runtime", () => {
    expect(map.edges).toContainEqual({
      from: "app.routes.orders.place_order",
      to: "app.services.orders.create_order",
      style: "runtime",
    });
  });

  it("marks a deleted function and the route that breaks through it", () => {
    const m = layoutRadar(branch, 760, 470);
    const node = (id: string) => m.nodes.find((n) => n.id === id)!;
    expect(m.hub).toBe(true);
    expect(node("app.services.orders.list_orders")).toMatchObject({ kind: "deleted", text: "× list_orders (DEL)" });
    expect(node("app.routes.orders.my_orders").breaks).toBe(true);
    expect(m.edges).toContainEqual({ from: "app.routes.orders.my_orders", to: "app.services.orders.list_orders", style: "broken" });
  });

  it("keeps boxes apart and inside the frame", () => {
    for (const m of [layoutRadar(report, 760, 460), layoutRadar(branch, 576, 380), layoutRadar(branch, 366, 366)]) {
      const box = (n: (typeof m.nodes)[number]) => ({
        left: n.bx - n.w / 2, right: n.bx + n.w / 2, top: n.by - n.h / 2, bottom: n.by + n.h / 2,
      });
      for (const n of m.nodes) {
        const b = box(n);
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(m.width);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.bottom).toBeLessThanOrEqual(m.height);
      }
      const boxed = m.nodes.filter((n) => n.boxed);
      for (let i = 0; i < boxed.length; i++)
        for (let j = i + 1; j < boxed.length; j++) expect(overlaps(box(boxed[i]), box(boxed[j]))).toBe(false);
    }
  });
});

describe("report helpers", () => {
  it("summarises in plain words", () => {
    expect(verdictSentences(report)).toEqual([
      "3 functions depend on send_receipt, including 1 API route.",
      "All of them were found only by running the tests.",
    ]);
  });

  it("calls out deletions and missing tests", () => {
    const r: Report = {
      ...report,
      affected: [],
      hidden_dependencies: [],
      changed: [{ ...report.changed[0], reached_by_tests: false }],
      deleted: [{ name: "app.services.orders.list_orders", file_path: "x.py", still_called_by: ["a.b"], call_sites: [] }],
    };
    expect(verdictSentences(r)).toEqual([
      "Nothing else depends on send_receipt.",
      "list_orders was deleted but 1 place still calls it.",
      "No test reaches it.",
    ]);
  });

  it("makes one tile per finding, with a will-break tile only when something breaks", () => {
    const brief = (r: Report) => tilesFor(r).map((t) => `${t.label}: ${t.value}`);
    expect(brief(report)).toEqual(["Risk score: 15", "Depends on it: 3", "API routes: 1", "Hidden: 3", "Tests to run: 2"]);
    expect(brief(branch)).toEqual(["Risk score: 79", "Will break: 1", "Depends on it: 4", "API routes: 2", "Tests to run: 3"]);
    const tiles = Object.fromEntries(tilesFor(branch).map((t) => [t.key, t]));
    expect(tiles.broken).toMatchObject({ tone: "broken", note: "orders.list_orders", target: "broken-h" });
    expect(tiles.routes.note).toBe("GET /orders/, POST /orders/");
    expect(tiles.depends).toMatchObject({ unit: "callers (2 direct)", note: "2 more, up to 3 steps away" });
    expect(tiles.risk).toMatchObject({ tone: "high", badge: "HIGH", bar: 79 });
  });

  it("explains how each route reaches the change", () => {
    const [myOrders, , , placeOrder] = branch.affected;
    expect(routeNote(branch, myOrders)).toBe("Calls deleted list_orders");
    expect(routeNote(branch, placeOrder)).toBe("3 steps via create_order");
    expect(testsNote(branch.tests_to_run)).toBe("all in tests/test_shop.py");
  });

  it("lists the score's parts biggest first", () => {
    expect(scoreParts(branch).map((p) => `${p.label} +${p.points}`)).toEqual([
      "Deleted but still called +55",
      "Code that depends on it +12",
      "API routes +12",
    ]);
  });

  it("marks files by the worst thing in them", () => {
    const marks = fileMarks(branch);
    expect(marks.get("app/services/orders.py")).toBe("deleted");
    expect(marks.get("app/services/pricing.py")).toBe("changed");
    expect(marks.get("app/routes/orders.py")).toBe("route");
  });
});

describe("diff reading", () => {
  it("numbers each side's lines and counts the changes", () => {
    const files = parseDiff(branchDiff);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["app/services/orders.py", 0, 4],
      ["app/services/pricing.py", 1, 1],
    ]);
    const pricing = files[1].lines;
    expect(pricing.find((l) => l.kind === "del")).toMatchObject({ oldNo: 9, newNo: null });
    expect(pricing.find((l) => l.kind === "add")).toMatchObject({ oldNo: null, newNo: 9 });
    expect(diffTotals(files)).toEqual({ added: 1, removed: 5 });
  });

  it("reads a plain `diff -u` without git headers", () => {
    const files = parseDiff("--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n--- a/y.py\n+++ b/y.py\n@@ -3 +3 @@\n-c\n+d\n");
    expect(files.map((f) => f.path)).toEqual(["x.py", "y.py"]);
  });
});

describe("small helpers", () => {
  it("builds a file tree with folders before files", () => {
    const rows = treeRows(["app/web.py", "app/routes/orders.py", "tests/test_shop.py"]);
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`)).toEqual([
      "app/",
      "  routes/",
      "    orders.py",
      "  web.py",
      "tests/",
      "  test_shop.py",
    ]);
  });

  it("takes a function's decorators and header, plus its first line", () => {
    const lines = ['@router.get("/")', "def my_orders(", "    token: str,", ") -> list[dict]:", "    return x", "    more"];
    expect(headerLines(lines)).toEqual(lines.slice(0, 5));
    expect(dedent(["    a", "      b"])).toEqual(["a", "  b"]);
    expect(highlight('def f(): return "x"').length).toBeGreaterThan(3);
  });

  it("reads JavaScript and TypeScript headers and colours their keywords", () => {
    expect(languageOf("src/app.ts")).toBe("js");
    expect(languageOf("app/web.py")).toBe("python");
    const ts = ["export async function createOrder(", "  userId: number,", "): Promise<Order> {", "  const x = 1;", "  more"];
    expect(headerLines(ts, "js")).toEqual(ts.slice(0, 4));
    const arrow = ["export const orderTotal = (items: Item[]): number =>", "  applyDiscount(subtotal(items));"];
    expect(headerLines(arrow, "js")).toEqual(arrow);
    const parts = highlight("const x = `a` // note", "js");
    expect(parts.filter((p) => typeof p !== "string").length).toBe(3);
  });

  it("names languages, parsers and test runners", () => {
    expect(languageLabel(["python", "typescript"])).toBe("Python + TypeScript");
    expect(languageLabel([])).toBe("");
    expect(parserLabel(undefined)).toBe("Python ast + TypeScript compiler");
    expect(parserLabel(["typescript"])).toBe("TypeScript compiler");
    expect(tracerLabel(["python", "javascript"], "jest")).toBe("pytest + jest");
  });
});

describe("test commands", () => {
  it("uses the command the API sends, one per runner", () => {
    const js = { ...report, test_command: "pytest t/test_a.py::test_b\nnpx vitest run a.test.ts -t '^(x)$'" };
    expect(testCommands(js)).toEqual(["pytest t/test_a.py::test_b", "npx vitest run a.test.ts -t '^(x)$'"]);
    expect(testRunnerName(js)).toBe("pytest + vitest");
  });

  it("builds the pytest one for reports saved before commands were sent", () => {
    const old = { ...report, test_command: "" };
    expect(testCommands(old)).toEqual([`pytest ${report.tests_to_run.join(" ")}`]);
    expect(testRunnerName({ ...report, tests_to_run: [], test_command: "" })).toBe("tests");
  });
});
