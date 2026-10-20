/** Realistic API responses, taken from the example shop app. */
import type { Analysis, Graph, RepoDetail, Snapshot, SnapshotStats } from "../api/types";

export const readySnapshot: Snapshot = {
  id: 7,
  repo_id: 1,
  ref: "main",
  commit_sha: "3f9c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f",
  status: "ready",
  error: null,
  want_dynamic: true,
  has_dynamic: true,
  symbol_count: 47,
  edge_count: 56,
  created_at: new Date(Date.now() - 60_000).toISOString(),
  scanned_at: new Date(Date.now() - 50_000).toISOString(),
  languages: ["python"],
  test_runner: "",
};

/** The `feature` branch: pricing changed, list_orders deleted. */
export const featureSnapshot: Snapshot = {
  ...readySnapshot,
  id: 8,
  ref: "feature",
  commit_sha: "52cb01ccbb2f0000000000000000000000000000",
  has_dynamic: false,
  symbol_count: 46,
  edge_count: 53,
};

export const repoDetail: RepoDetail = {
  id: 1,
  name: "shop_api",
  url: "/Users/nikhil/Desktop/aftershock/examples/shop_api",
  subdir: "",
  default_branch: "main",
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  snapshots: [readySnapshot],
};

export const stats: SnapshotStats = {
  languages: ["python"],
  test_runner: "",
  symbols: 47,
  links: 56,
  files: 14,
  routes: 4,
  tests: 3,
  read_from_code: 55,
  seen_running: 20,
  confirmed: 19,
  runtime_only: 1,
  unresolved_calls: 4,
};

export const analysis: Analysis = {
  id: 3,
  snapshot_id: 7,
  risk_score: 15,
  risk_level: "low",
  created_at: new Date().toISOString(),
  report: {
    changed: [
      {
        name: "app.services.hooks.send_receipt",
        kind: "function",
        file_path: "app/services/hooks.py",
        line: 10,
        distance: 0,
        via: [],
        reached_by_tests: true,
        confidence: "static",
        route: "",
        call_line: 0,
      },
    ],
    affected: [
      {
        name: "app.services.hooks.run_hook",
        kind: "function",
        file_path: "app/services/hooks.py",
        line: 14,
        distance: 1,
        via: ["app.services.hooks.run_hook", "app.services.hooks.send_receipt"],
        reached_by_tests: true,
        confidence: "dynamic",
        route: "",
        call_line: 16,
      },
      {
        name: "app.services.orders.create_order",
        kind: "function",
        file_path: "app/services/orders.py",
        line: 6,
        distance: 2,
        via: ["app.services.orders.create_order", "app.services.hooks.run_hook", "app.services.hooks.send_receipt"],
        reached_by_tests: true,
        confidence: "dynamic",
        route: "",
        call_line: 8,
      },
      {
        name: "app.routes.orders.place_order",
        kind: "route",
        file_path: "app/routes/orders.py",
        line: 8,
        distance: 3,
        via: [
          "app.routes.orders.place_order",
          "app.services.orders.create_order",
          "app.services.hooks.run_hook",
          "app.services.hooks.send_receipt",
        ],
        reached_by_tests: true,
        confidence: "dynamic",
        route: "POST /orders/",
        call_line: 10,
      },
    ],
    tests_to_run: [
      "tests/test_shop.py::test_my_orders_lists_only_mine",
      "tests/test_shop.py::test_place_order_sends_receipt",
    ],
    deleted: [],
    hidden_dependencies: [
      "app.services.hooks.run_hook",
      "app.services.orders.create_order",
      "app.routes.orders.place_order",
    ],
    risk: {
      score: 15,
      level: "low",
      parts: { spread: 7, routes: 7, untested: 0, broken: 0 },
      reasons: [
        "3 symbols depend on this change (1 directly)",
        "1 API route runs the changed code",
        "3 of them were found only by running the tests (invisible in the code)",
      ],
    },
    depth: 3,
    summary: { changed: 1, direct: 1, indirect: 2, routes: 1, untested: 0, deleted_but_still_called: 0 },
    test_command:
      "pytest tests/test_shop.py::test_my_orders_lists_only_mine tests/test_shop.py::test_place_order_sends_receipt",
  },
};

const sym = (name: string, file: string, line: number, distance: number, via: string[], extra = {}) => ({
  name,
  kind: "function",
  file_path: file,
  line,
  distance,
  via,
  reached_by_tests: true,
  confidence: "static" as const,
  route: "",
  call_line: 0,
  ...extra,
});

/** feature compared with main: like a pull request that breaks GET /orders/. */
export const branchAnalysis: Analysis = {
  id: 4,
  snapshot_id: 8,
  risk_score: 79,
  risk_level: "high",
  created_at: new Date().toISOString(),
  report: {
    changed: [sym("app.services.pricing.apply_discount", "app/services/pricing.py", 8, 0, [])],
    affected: [
      sym("app.routes.orders.my_orders", "app/routes/orders.py", 13, 1,
        ["app.routes.orders.my_orders", "app.services.orders.list_orders"],
        { kind: "route", route: "GET /orders/", call_line: 15 }),
      sym("app.services.pricing.order_total", "app/services/pricing.py", 12, 1,
        ["app.services.pricing.order_total", "app.services.pricing.apply_discount"], { call_line: 13 }),
      sym("app.services.orders.create_order", "app/services/orders.py", 6, 2,
        ["app.services.orders.create_order", "app.services.pricing.order_total", "app.services.pricing.apply_discount"]),
      sym("app.routes.orders.place_order", "app/routes/orders.py", 8, 3,
        ["app.routes.orders.place_order", "app.services.orders.create_order", "app.services.pricing.order_total",
          "app.services.pricing.apply_discount"],
        { kind: "route", route: "POST /orders/" }),
    ],
    tests_to_run: [
      "tests/test_shop.py::test_my_orders_lists_only_mine",
      "tests/test_shop.py::test_order_total_applies_discount",
      "tests/test_shop.py::test_place_order_sends_receipt",
    ],
    deleted: [
      {
        name: "app.services.orders.list_orders",
        file_path: "app/services/orders.py",
        still_called_by: ["app.routes.orders.my_orders"],
        call_sites: [{ caller: "app.routes.orders.my_orders", file_path: "app/routes/orders.py", line: 15 }],
      },
    ],
    hidden_dependencies: [],
    risk: {
      score: 79,
      level: "high",
      parts: { spread: 12, routes: 12, untested: 0, broken: 55 },
      reasons: ["4 symbols depend on this change (2 directly)"],
    },
    depth: 3,
    summary: { changed: 1, direct: 2, indirect: 2, routes: 2, untested: 0, deleted_but_still_called: 1 },
    test_command:
      "pytest tests/test_shop.py::test_my_orders_lists_only_mine tests/test_shop.py::test_order_total_applies_discount tests/test_shop.py::test_place_order_sends_receipt",
  },
};

export const branchDiff = `diff --git a/app/services/orders.py b/app/services/orders.py
--- a/app/services/orders.py
+++ b/app/services/orders.py
@@ -9,5 +9,2 @@ def create_order(user_id: int, items: list[dict]) -> dict:
     return order
-
-
-def list_orders(user_id: int) -> list[dict]:
-    return db.select(user_id)
diff --git a/app/services/pricing.py b/app/services/pricing.py
--- a/app/services/pricing.py
+++ b/app/services/pricing.py
@@ -8,3 +8,3 @@ def subtotal(items: list[dict]) -> float:
 def apply_discount(amount: float) -> float:
-    return round(amount * (1 - settings.discount_rate), 2)
+    return round(amount * (1 - settings.discount_rate), 1)

`;

export const graph: Graph = {
  focus: "app.services.hooks.send_receipt",
  truncated: false,
  nodes: [
    { id: "app.services.hooks.send_receipt", kind: "function", file_path: "app/services/hooks.py", line: 10, is_test: false, route: "" },
    { id: "app.services.hooks.run_hook", kind: "function", file_path: "app/services/hooks.py", line: 14, is_test: false, route: "" },
    { id: "app.services.orders.create_order", kind: "function", file_path: "app/services/orders.py", line: 6, is_test: false, route: "" },
    { id: "app.services.hooks.SENT", kind: "variable", file_path: "app/services/hooks.py", line: 7, is_test: false, route: "" },
  ],
  edges: [
    { source: "app.services.hooks.run_hook", target: "app.services.hooks.send_receipt", kinds: ["calls"], confidence: "dynamic", line: 16 },
    { source: "app.services.orders.create_order", target: "app.services.hooks.run_hook", kinds: ["calls"], confidence: "both", line: 8 },
    { source: "app.services.hooks.send_receipt", target: "app.services.hooks.SENT", kinds: ["references"], confidence: "static", line: 11 },
  ],
};
