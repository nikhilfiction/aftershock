/** A fake API for tests. Each test can override a route with server.use(...). */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

import { analysis, branchDiff, featureSnapshot, graph, readySnapshot, repoDetail, stats } from "./fixtures";

export const API = "http://localhost:8000/api"; // set for tests in vite.config.ts

const SYMBOLS = [
  { name: "app.services.hooks.send_receipt", kind: "function", file_path: "app/services/hooks.py", line: 10, is_test: false, route: "" },
  { name: "app.services.orders.create_order", kind: "function", file_path: "app/services/orders.py", line: 6, is_test: false, route: "" },
  { name: "app.routes.orders.place_order", kind: "route", file_path: "app/routes/orders.py", line: 8, is_test: false, route: "POST /orders/" },
  { name: "app.routes.orders.my_orders", kind: "route", file_path: "app/routes/orders.py", line: 13, is_test: false, route: "GET /orders/" },
];

const FILES = ["app/__init__.py", "app/routes/orders.py", "app/services/hooks.py", "app/services/orders.py", "app/services/pricing.py", "tests/test_shop.py"];

const SOURCE: Record<string, string[]> = {
  "app/services/hooks.py": [
    '"""Hooks run after an order is placed."""', "", "", "", "", "", "SENT: list[int] = []", "", "",
    "def send_receipt(order: dict) -> None:", '    SENT.append(order["id"])', "", "",
    "def run_hook(name: str, order: dict) -> None:", "    hook = globals()[name]", "    hook(order)",
  ],
};

export const server = setupServer(
  http.get(`${API}/health`, () => HttpResponse.json({ ok: true, version: "1.0.0", queue: "in-process", database: "sqlite" })),
  http.get(`${API}/repos`, () => HttpResponse.json([repoDetail])),
  http.get(`${API}/repos/1`, () => HttpResponse.json(repoDetail)),
  http.get(`${API}/snapshots/7`, () => HttpResponse.json(readySnapshot)),
  http.get(`${API}/snapshots/8`, () => HttpResponse.json(featureSnapshot)),
  http.get(`${API}/snapshots/:id/stats`, () => HttpResponse.json(stats)),
  http.get(`${API}/snapshots/:id/symbols`, ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? "";
    const kind = url.searchParams.get("kind");
    if (kind === "module") {
      return HttpResponse.json(FILES.map((f) => ({ name: f, kind: "module", file_path: f, line: 1, is_test: f.startsWith("tests"), route: "" })));
    }
    return HttpResponse.json(SYMBOLS.filter((s) => s.name.includes(q) && (!kind || s.kind === kind)));
  }),
  http.get(`${API}/snapshots/:id/source`, ({ request }) => {
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "";
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    const lines = SOURCE[path];
    if (!lines) return HttpResponse.json({ detail: `${path} is not on disk any more` }, { status: 404 });
    return HttpResponse.json({ path, start, lines: lines.slice(start - 1, end) });
  }),
  http.post(`${API}/snapshots/:id/blast-radius`, () => HttpResponse.json(analysis)),
  http.get(`${API}/snapshots/:id/graph`, () => HttpResponse.json(graph)),
  http.get(`${API}/analyses/:id/diff`, () => HttpResponse.text(branchDiff)),
);
