/**
 * Positions for the dependency radar: the change in the middle, everything
 * that depends on it on rings, one ring per step away.
 *
 * It is a radial tree. A dependent's parent is the next symbol on its way to
 * the change (via[1]), and every branch gets a slice of the circle sized by
 * how many ends it has, so a chain like place_order -> create_order -> run_hook
 * stays in one direction. The biggest branch points down; a slice is kept free
 * for the ring labels. Names sit in boxes, and boxes that would overlap are pushed
 * apart sideways. Kept free of React so it can be tested.
 */
import type { Report } from "../api/types";
import { shortLabel } from "./format";
import { breaksThrough } from "./report";

export type FilterKey = "broken" | "depends" | "routes" | "runtime";

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "broken", label: "Will break" },
  { key: "depends", label: "Depends on it" },
  { key: "routes", label: "API routes" },
  { key: "runtime", label: "Found only at runtime" },
];

export type RadarKind = "changed" | "deleted" | "route" | "hidden" | "depends";

export type RadarNode = {
  id: string;
  kind: RadarKind;
  symbolKind: string;
  text: string;            // what the box says
  caption: string;         // small text under the box, "" for none
  distance: number;        // 0 = changed or deleted
  angle: number;           // radians, 0 = right, PI/2 = down
  x: number;               // the point on its ring
  y: number;
  bx: number;              // the box centre, after making room
  by: number;
  w: number;
  h: number;
  boxed: boolean;          // false: a small dot, to keep a crowded radar readable
  runtimeOnly: boolean;    // reached only through calls seen while the tests ran
  breaks: boolean;         // its way to the change runs through a deleted function
};

export type RadarEdge = { from: string; to: string; style: "code" | "runtime" | "broken" };

export type RadarRing = {
  distance: number;
  r: number;            // radius up and down
  rx: number;           // radius left and right: rings are a little wider than tall in a wide frame
  label: string;
  lx: number;
  ly: number;
  anchor: "start" | "middle";
};

export type RadarLayout = {
  width: number;
  height: number;
  center: { x: number; y: number };
  hub: boolean;            // several changes share the middle
  rings: RadarRing[];
  nodes: RadarNode[];
  edges: RadarEdge[];
};

export const FONT = 10;
const CHAR_W = FONT * 0.6;       // JetBrains Mono: every character is 0.6em wide
const BOX_H = 20;
const PAD_X = 8;
const DOT_ROOM = 10;             // a coloured dot inside route and runtime boxes
const MAX_BOXES = 16;            // above this, far plain callers become dots
const GAP = (40 * Math.PI) / 180; // the slice at the top kept for ring labels
const CENTER_LABEL_DY = 30;      // the changed function's name sits under its dot
const ROOT = "__change__";

const boxWidth = (text: string, dot: boolean) => Math.round(text.length * CHAR_W + 2 * PAD_X + (dot ? DOT_ROOM : 0));

export function layoutRadar(report: Report, width = 760, height = 440): RadarLayout {
  const cx = width / 2;
  const cy = height / 2;
  const centers = [
    ...report.changed.map((s) => ({ id: s.name, symbolKind: s.kind, deleted: false })),
    ...report.deleted.map((d) => ({ id: d.name, symbolKind: "function", deleted: true })),
  ];
  const affected = report.affected;
  const hub = centers.length !== 1;
  const D = Math.max(1, ...affected.map((s) => s.distance));

  // room at the top and bottom for a box and the caption under it
  const outer = Math.max(70, Math.min(height / 2 - BOX_H - 18, width / 2 - 40));
  // in a wide frame the rings stretch sideways, so side branches get room for their names
  const kx = Math.max(1, Math.min(1.6, width / height, (width / 2 - 50) / outer));
  const r0 = hub ? Math.min(54, outer * 0.3) : 0;
  const first = Math.max(58, outer / D);
  const ringRadius = (d: number) =>
    hub ? r0 + ((outer - r0) * d) / D : D === 1 ? Math.min(outer, 120) : first + ((outer - first) * (d - 1)) / (D - 1);

  // ---- the tree: who hangs off whom
  const known = new Set([...centers.map((c) => c.id), ...affected.map((s) => s.name)]);
  const root = hub ? ROOT : centers[0].id;
  const parentOf = new Map<string, string>();
  for (const c of centers) if (c.id !== root) parentOf.set(c.id, ROOT);
  for (const s of affected) {
    const next = s.via[1];
    parentOf.set(s.name, next && known.has(next) && next !== s.name ? next : root);
  }
  const children = new Map<string, string[]>();
  for (const [child, parent] of parentOf) children.set(parent, [...(children.get(parent) ?? []), child]);
  const isRoute = new Set(affected.filter((s) => s.kind === "route").map((s) => s.name));
  for (const list of children.values()) {
    // routes first, then by name, so the same report always draws the same way
    list.sort((a, b) => Number(isRoute.has(b)) - Number(isRoute.has(a)) || a.localeCompare(b));
  }

  const leaves = new Map<string, number>();
  const countLeaves = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0; // a guard; shortest paths cannot loop
    seen.add(id);
    const kids = children.get(id) ?? [];
    const n = kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + countLeaves(k, seen), 0);
    leaves.set(id, n);
    return n;
  };
  countLeaves(root, new Set());

  const angleOf = new Map<string, number>();
  const assign = (id: string, start: number, end: number) => {
    angleOf.set(id, (start + end) / 2);
    const kids = children.get(id) ?? [];
    const total = kids.reduce((sum, k) => sum + (leaves.get(k) ?? 1), 0);
    let at = start;
    for (const k of kids) {
      const span = ((end - start) * (leaves.get(k) ?? 1)) / total;
      assign(k, at, at + span);
      at += span;
    }
  };
  // everything but a slice on the left, then turned so the biggest branch points
  // straight down: boxes stack well vertically, and a lone chain reads top to bottom
  assign(root, -Math.PI + GAP / 2, Math.PI - GAP / 2);
  const size = (id: string): number => 1 + (children.get(id) ?? []).reduce((n, k) => n + size(k), 0);
  const biggest = [...(children.get(root) ?? [])].sort((a, b) => size(b) - size(a))[0];
  const turn = Math.PI / 2 - (biggest ? (angleOf.get(biggest) ?? 0) : 0);
  for (const [id, a] of angleOf) angleOf.set(id, a + turn);
  const gapAngle = Math.PI + turn;          // the free slice, where the ring labels go
  const labelAbove = Math.sin(gapAngle) < -0.5;

  // ---- nodes
  const nodes: RadarNode[] = [];
  const crowded = affected.length + centers.length > MAX_BOXES;
  for (const c of centers) {
    const angle = angleOf.get(c.id) ?? Math.PI / 2;
    const r = hub ? r0 : 0;
    const short = shortLabel(c.id, c.symbolKind);
    const text = c.deleted ? `× ${short} (DEL)` : short;
    const x = cx + r * kx * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    nodes.push({
      id: c.id, kind: c.deleted ? "deleted" : "changed", symbolKind: c.symbolKind, text, caption: "",
      distance: 0, angle, x, y, bx: x, by: hub ? y : y + (labelAbove ? -CENTER_LABEL_DY : CENTER_LABEL_DY),
      w: boxWidth(text, false), h: BOX_H,
      boxed: true, runtimeOnly: false, breaks: false,
    });
  }
  for (const s of affected) {
    const angle = angleOf.get(s.name) ?? Math.PI / 2;
    const r = ringRadius(s.distance);
    const runtimeOnly = s.confidence === "dynamic";
    const route = s.kind === "route";
    const short = shortLabel(s.name, s.kind);
    const kind: RadarKind = route ? "route" : runtimeOnly ? "hidden" : "depends";
    const text = route && s.route ? s.route : short;
    const x = cx + r * kx * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    nodes.push({
      id: s.name, kind, symbolKind: s.kind, text, caption: route && s.route && short !== s.route ? short : "",
      distance: s.distance, angle, x, y, bx: x, by: y, w: boxWidth(text, route || runtimeOnly), h: BOX_H,
      boxed: !crowded || s.distance <= 1 || route || runtimeOnly,
      runtimeOnly, breaks: Boolean(breaksThrough(report, s)),
    });
  }
  for (const n of nodes) {
    if (!n.boxed) {
      n.w = 8;
      n.h = 8;
    }
  }

  makeRoom(nodes, hub ? null : { x: cx, y: cy }, width, height);

  // ---- edges: each dependent to the next one toward the change
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deleted = new Set(report.deleted.map((d) => d.name));
  const edges: RadarEdge[] = [];
  for (const [child, parent] of parentOf) {
    if (parent === ROOT || !byId.has(child)) continue;
    const c = byId.get(child)!;
    edges.push({
      from: child,
      to: parent,
      style: deleted.has(parent) ? "broken" : c.runtimeOnly ? "runtime" : "code",
    });
  }

  const rings: RadarRing[] = Array.from({ length: D }, (_, i) => {
    const d = i + 1;
    const r = ringRadius(d);
    const px = cx + r * kx * Math.cos(gapAngle);
    const py = cy + r * Math.sin(gapAngle);
    const upright = Math.abs(Math.sin(gapAngle)) > 0.5;
    // labels side by side on one line stay short: numbers inside, the unit once on the outer ring
    const label = upright ? (d === 1 ? "1 STEP · DIRECT" : `${d} STEPS`) : d === D ? `${d} STEPS` : String(d);
    return upright
      ? { distance: d, r, rx: r * kx, label, lx: px + 5, ly: py + (Math.sin(gapAngle) < 0 ? 11 : -4), anchor: "start" }
      : { distance: d, r, rx: r * kx, label, lx: px, ly: py - 4, anchor: "middle" };
  });

  return { width, height, center: { x: cx, y: cy }, hub, rings, nodes, edges };
}

type Box = { left: number; right: number; top: number; bottom: number };

function boxOf(n: RadarNode, center: { x: number; y: number } | null): Box {
  if (center && n.distance === 0 && n.kind === "changed") {
    // the changed function: its dot and the name next to it
    return {
      left: Math.min(n.bx - n.w / 2, center.x - 14),
      right: Math.max(n.bx + n.w / 2, center.x + 14),
      top: Math.min(n.by - n.h / 2, center.y - 14),
      bottom: Math.max(n.by + n.h / 2, center.y + 14),
    };
  }
  return { left: n.bx - n.w / 2, right: n.bx + n.w / 2, top: n.by - n.h / 2, bottom: n.by + n.h / 2 + (n.caption ? 12 : 0) };
}

const PAD = 4;

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right + PAD && b.left < a.right + PAD && a.top < b.bottom + PAD && b.top < a.bottom + PAD;
}

/**
 * Pushes overlapping boxes apart along their ring (sideways to the line from
 * the centre), outer ones first, alternating direction from ring to ring, then
 * keeps every box inside the frame.
 */
function makeRoom(nodes: RadarNode[], center: { x: number; y: number } | null, width: number, height: number) {
  const order = [...nodes].sort((a, b) => a.distance - b.distance);
  const clamp = (n: RadarNode) => {
    n.bx = Math.min(Math.max(n.bx, n.w / 2 + 2), width - n.w / 2 - 2);
    n.by = Math.min(Math.max(n.by, n.h / 2 + 2), height - n.h / 2 - (n.caption ? 14 : 2));
  };
  order.forEach(clamp);
  for (let round = 0; round < 60; round++) {
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = order[i];
        const b = order[j];
        if (!overlaps(boxOf(a, center), boxOf(b, center))) continue;
        const mover = b.distance === 0 && a.distance > 0 ? a : b;
        let sign = mover.distance % 2 === 0 ? 1 : -1;
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = [mover.bx, mover.by];
          mover.bx += -Math.sin(mover.angle) * 6 * sign;
          mover.by += Math.cos(mover.angle) * 6 * sign;
          clamp(mover);
          if (Math.hypot(mover.bx - before[0], mover.by - before[1]) > 0.5) break;
          sign = -sign; // up against the frame: go the other way
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}
