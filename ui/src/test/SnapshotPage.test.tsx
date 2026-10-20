import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import SnapshotPage from "../pages/SnapshotPage";
import { analysis, branchAnalysis, readySnapshot } from "./fixtures";
import { renderAt } from "./render";
import { API, server } from "./server";

// React Flow needs a real browser layout engine; the graph has its own layout test
vi.mock("../components/report/GraphPanel", () => ({
  default: ({ focus }: { focus: string | null }) => <p>graph focused on {focus ?? "modules"}</p>,
}));

const open = (path = "/snapshots/7") => renderAt(path, "/snapshots/:snapshotId", <SnapshotPage />);

describe("Scan page", () => {
  it("finds a function, runs the analysis and shows its hidden callers", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/snapshots/7/blast-radius`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(analysis);
      }),
    );
    const { user } = open();
    expect(await screen.findByText("What would a change affect?")).toBeInTheDocument();

    const search = screen.getByRole("combobox", { name: "Function, class or route" });
    await user.type(search, "send");
    await user.click(await screen.findByRole("option", { name: /send_receipt/ }));
    expect(search).toHaveValue("app.services.hooks.send_receipt");

    await user.click(screen.getByRole("button", { name: "Show blast radius" }));

    expect(await screen.findByText("Low risk:")).toBeInTheDocument();
    expect(body).toEqual({ targets: ["app.services.hooks.send_receipt"], depth: 3 });

    // the summary tiles: one coloured number per finding, each jumps to its section
    const summary = screen.getByRole("list", { name: "Summary" });
    expect(within(summary).getAllByRole("listitem")).toHaveLength(5);
    expect(within(summary).getByRole("link", { name: /API routes\s*1/ })).toHaveAttribute("href", "#routes-h");

    // reading the code finds no caller; the tests found three, with the line of code that calls
    const hidden = screen.getByRole("region", { name: "Hidden callers found" });
    expect(within(hidden).getAllByRole("listitem")).toHaveLength(3);
    expect(within(hidden).getByText(/Calls send_receipt at hooks.py:16/)).toBeInTheDocument();
    expect(await within(hidden).findByText("hook(order)")).toBeInTheDocument();

    // the verdict reads as a sentence
    expect(screen.getByText(/3 functions depend on send_receipt, including 1 API route/)).toBeInTheDocument();
    // the radar draws all three dependents, the route as a button you can reach by keyboard
    expect(
      screen.getByRole("button", { name: /place_order, 3 steps away, API route, found only at runtime/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy test command" })).toBeInTheDocument();
    // the changed function's own code, read from the scan
    const changed = screen.getByRole("region", { name: "Changed function" });
    expect(await within(changed).findByText("send_receipt")).toBeInTheDocument();
    expect(within(changed).getByText(/Nothing will break/)).toBeInTheDocument();
    // the call graph centres on the changed function
    expect(await screen.findByText("graph focused on app.services.hooks.send_receipt")).toBeInTheDocument();
  });

  it("shows the Vitest command for a TypeScript project", async () => {
    const ts = {
      ...analysis,
      report: {
        ...analysis.report,
        tests_to_run: ["tests/shop.test.ts::orders sends a receipt when an order is placed"],
        test_command:
          "npx vitest run tests/shop.test.ts -t '^(orders sends a receipt when an order is placed)$'",
      },
    };
    server.use(http.post(`${API}/snapshots/7/blast-radius`, () => HttpResponse.json(ts)));
    open("/snapshots/7?fn=app.services.hooks.send_receipt");
    const terminal = await screen.findByRole("group", { name: "vitest command" });
    expect(within(terminal).getByText("npx vitest run", { exact: false })).toBeInTheDocument();
    expect(within(terminal).getByText(/-t '\^\(orders sends a receipt when an order is placed\)\$'/)).toBeInTheDocument();
  });

  it("runs the question in the address straight away", async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/snapshots/7/blast-radius`, () => {
        calls++;
        return HttpResponse.json(analysis);
      }),
    );
    open("/snapshots/7?fn=app.services.hooks.send_receipt&depth=2");
    expect(await screen.findByText("Low risk:")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Function, class or route" })).toHaveValue(
      "app.services.hooks.send_receipt",
    );
    expect(screen.getByRole("combobox", { name: "How far to follow" })).toHaveValue("2");
    expect(calls).toBe(1);
  });

  it("reads a branch comparison like a pull request review", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/snapshots/8/blast-radius`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(branchAnalysis);
      }),
    );
    open("/snapshots/8?base=main");
    expect(await screen.findByRole("heading", { name: /Breaking change detected/ })).toBeInTheDocument();
    expect(body).toEqual({ base: "main", depth: 3 });

    const alert = screen.getByRole("region", { name: /Breaking change detected/ });
    expect(alert).toHaveTextContent(
      "app.services.orders.list_orders was deleted in this branch, but app.routes.orders.my_orders still calls it at app/routes/orders.py:15.",
    );
    const tiles = within(screen.getByRole("list", { name: "Summary" }));
    expect(tiles.getByRole("link", { name: /Will break\s*1\s*deleted but called/ })).toBeInTheDocument();

    const routes = screen.getByRole("region", { name: "Exposed API routes" });
    const cards = within(routes).getAllByRole("listitem");
    expect(cards[0]).toHaveTextContent("GET/orders/BREAKING");
    expect(cards[0]).toHaveTextContent("Calls deleted list_orders");
    expect(cards[1]).toHaveTextContent("POST/orders/AFFECTED");
    expect(cards[1]).toHaveTextContent("3 steps via create_order");

    // the branch's diff, with the line numbers of each side
    const diff = screen.getByRole("region", { name: /Changed code/ });
    expect(await within(diff).findByText("app/services/pricing.py")).toBeInTheDocument();
    expect(within(diff).getByText("9 -")).toBeInTheDocument();
    expect(within(diff).getByText("9 +")).toBeInTheDocument();

    // the files the change touches are marked in the tree
    const tree = screen.getByRole("region", { name: "Files in this scan" });
    expect(await within(tree).findByText("A deleted function here is still called")).toBeInTheDocument();
    expect(within(tree).getByText("Changed in this comparison")).toBeInTheDocument();

    // the sidebar lists this layout's sections
    const nav = screen.getByRole("navigation", { name: "On this report" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Dependency radar",
      "Breaking changes",
      "API routes",
      "Tests to run",
      "Code diff",
      "Back to shop_api",
    ]);
  });

  it("hides points on the radar with the filters", async () => {
    server.use(http.post(`${API}/snapshots/8/blast-radius`, () => HttpResponse.json(branchAnalysis)));
    const { user } = open("/snapshots/8?base=main");
    const route = await screen.findByRole("button", { name: /my_orders, 1 step away, API route, will break/ });
    expect(route).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "API routes" }));
    expect(screen.queryByRole("button", { name: /my_orders, 1 step away/ })).not.toBeInTheDocument();

    // picking a point shows where it is and offers its own blast radius
    await user.click(screen.getByRole("button", { name: /order_total, 1 step away/ }));
    expect(screen.getByText("app/services/pricing.py:12 · 1 step away")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blast radius of this" })).toBeInTheDocument();
  });

  it("shows API errors from the analysis next to the field", async () => {
    server.use(
      http.post(`${API}/snapshots/7/blast-radius`, () =>
        HttpResponse.json({ detail: [{ loc: ["body", "base"], msg: "fatal: Not a valid object name nope" }] }, { status: 422 }),
      ),
    );
    const { user } = open();
    await user.click(await screen.findByRole("tab", { name: "Compared to a branch" }));
    const base = screen.getByRole("textbox", { name: "Base branch" });
    await user.type(base, "nope");
    await user.click(screen.getByRole("button", { name: "Show blast radius" }));
    expect(await screen.findByText("fatal: Not a valid object name nope")).toBeInTheDocument();
    expect(base).toHaveAttribute("aria-invalid", "true");
  });

  it("disables branch comparison for a plain folder", async () => {
    server.use(http.get(`${API}/snapshots/7`, () => HttpResponse.json({ ...readySnapshot, commit_sha: "working-tree" })));
    const { user } = open();
    await user.click(await screen.findByRole("tab", { name: "Compared to a branch" }));
    expect(screen.getByRole("textbox", { name: "Base branch" })).toBeDisabled();
    expect(screen.getByText(/plain folder with no git history/)).toBeInTheDocument();
  });

  it("waits for a scan that is still running", async () => {
    server.use(http.get(`${API}/snapshots/7`, () => HttpResponse.json({ ...readySnapshot, status: "tracing" })));
    open();
    expect(await screen.findByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText(/updates by itself/)).toBeInTheDocument();
  });
});
