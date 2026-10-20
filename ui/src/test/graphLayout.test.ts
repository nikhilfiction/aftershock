import { describe, expect, it } from "vitest";

import { layoutGraph } from "../components/report/graphLayout";
import { analysis, graph } from "./fixtures";

describe("call graph layout", () => {
  it("places callers above what they call, and what it uses below", () => {
    const { nodes } = layoutGraph(graph, analysis.report);
    const y = (id: string) => nodes.find((n) => n.id === id)!.position.y;
    expect(y("app.services.orders.create_order")).toBeLessThan(y("app.services.hooks.run_hook"));
    expect(y("app.services.hooks.run_hook")).toBeLessThan(y("app.services.hooks.send_receipt"));
    expect(y("app.services.hooks.send_receipt")).toBeLessThan(y("app.services.hooks.SENT"));
  });

  it("labels each card with its step, and marks runtime-only callers", () => {
    const { nodes } = layoutGraph(graph, analysis.report);
    const card = (id: string) => nodes.find((n) => n.id === id)!.data;
    expect(card("app.services.hooks.send_receipt")).toMatchObject({ role: "focus", step: "Changed function" });
    expect(card("app.services.hooks.run_hook")).toMatchObject({
      role: "hidden",
      step: "Step 1",
      badge: { text: "Runtime only", tone: "hidden" },
    });
    expect(card("app.services.orders.create_order").step).toBe("Step 2");
    expect(card("app.services.hooks.SENT")).toMatchObject({ role: "callee", step: "Uses · variable" });
  });

  it("draws runtime-only links dashed in purple", () => {
    const { edges } = layoutGraph(graph, analysis.report);
    const dynamic = edges.find((e) => e.data?.confidence === "dynamic")!;
    const both = edges.find((e) => e.data?.confidence === "both")!;
    expect(dynamic.style).toMatchObject({ stroke: "#c084fc", strokeDasharray: "5 4" });
    expect(both.style).not.toHaveProperty("strokeDasharray");
  });
});
