/**
 * Turns the API's graph into positioned React Flow nodes and edges.
 * Kept free of React so it can be tested on its own.
 *
 * Layout: dagre, top to bottom, so callers sit above what they call.
 */
import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";

import type { Graph, Report } from "../../api/types";

export const NODE_W = 236;
export const NODE_H = 62;

export type Role = "focus" | "changed" | "caller" | "hidden" | "callee" | "module" | "other";

export type CardData = {
  name: string;
  kind: string;
  file: string;
  role: Role;
  step: string;                                   // e.g. "Step 2", "Uses", "Changed function"
  badge?: { text: string; tone: "route" | "hidden" | "changed" };
};

// grey = read from code, light = confirmed at runtime, purple dashed = only at runtime
const EDGE_STYLE = {
  static: { stroke: "#8c909f", strokeWidth: 1.25 },
  both: { stroke: "#dfe2ec", strokeWidth: 1.5 },
  dynamic: { stroke: "#c084fc", strokeWidth: 1.5, strokeDasharray: "5 4" },
} as const;

/** How many steps each node is from `start`, following edges forward or backward. */
function stepsFrom(graph: Graph, start: string, backward: boolean): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const e of graph.edges) {
    const [a, b] = backward ? [e.target, e.source] : [e.source, e.target];
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const n of next.get(at) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(at)! + 1);
        queue.push(n);
      }
    }
  }
  dist.delete(start);
  return dist;
}

export function layoutGraph(graph: Graph, report?: Report | null): { nodes: Node<CardData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 36, marginx: 10, marginy: 10 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const focus = graph.focus;
  const callers = focus ? stepsFrom(graph, focus, true) : new Map<string, number>();
  const callees = focus ? stepsFrom(graph, focus, false) : new Map<string, number>();
  const changed = new Set(report?.changed.map((s) => s.name) ?? []);
  const hidden = new Set(report?.hidden_dependencies ?? []);

  const nodes: Node<CardData>[] = graph.nodes.map((n) => {
    const pos = g.node(n.id);
    let role: Role = "other";
    let step = n.kind;
    if (n.kind === "module" && !focus) {
      role = "module";
      step = "file";
    } else if (n.id === focus) {
      role = "focus";
      step = changed.has(n.id) ? `Changed ${n.kind === "route" ? "route" : "function"}` : `In focus · ${n.kind}`;
    } else if (callers.has(n.id)) {
      role = hidden.has(n.id) ? "hidden" : changed.has(n.id) ? "changed" : "caller";
      step = `Step ${callers.get(n.id)}${n.kind === "route" ? " · route" : ""}`;
    } else if (callees.has(n.id)) {
      role = "callee";
      step = `Uses · ${n.kind}`;
    }
    const badge: CardData["badge"] =
      n.kind === "route" && n.route
        ? { text: n.route, tone: "route" }
        : role === "hidden"
          ? { text: "Runtime only", tone: "hidden" }
          : role === "focus" && changed.has(n.id)
            ? { text: "Changed", tone: "changed" }
            : undefined;
    return {
      id: n.id,
      type: "card",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { name: n.id, kind: n.kind, file: `${n.file_path}:${n.line}`, role, step, badge },
      width: NODE_W,
      height: NODE_H,
    };
  });

  const edges: Edge[] = graph.edges.map((e) => {
    const style = EDGE_STYLE[e.confidence as keyof typeof EDGE_STYLE] ?? EDGE_STYLE.static;
    return {
      id: `${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      style,
      markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
      ariaLabel: `${e.source} uses ${e.target} (${e.confidence})`,
      data: { confidence: e.confidence },
    };
  });

  return { nodes, edges };
}
