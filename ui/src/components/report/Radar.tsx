/**
 * The dependency radar: the change in the middle, what depends on it on rings
 * by distance. Grey boxes depend on it through code, purple ones were found
 * only while the tests ran, sky-blue ones are API routes, red is deleted.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Report } from "../../api/types";
import { layoutRadar, type FilterKey, type RadarNode } from "../../lib/radarLayout";
import { useElementWidth } from "../../lib/useLayout";
import { Icon } from "../Icon";

type Props = {
  report: Report;
  hidden: Set<FilterKey>;
  variant: "wide" | "tall";
  selected: string | null;
  onPick: (name: string) => void;
};

const STEP = (d: number) => (d === 1 ? "1 step" : `${d} steps`);
const ZOOMS = [1, 1.25, 1.5, 2, 2.5];

function isShown(n: RadarNode, hidden: Set<FilterKey>): boolean {
  if (n.kind === "changed") return true;
  if ((n.kind === "deleted" || n.breaks) && hidden.has("broken")) return false;
  if (n.runtimeOnly && hidden.has("runtime")) return false;
  if (n.kind === "route" && hidden.has("routes")) return false;
  if (n.kind !== "route" && n.kind !== "deleted" && !n.runtimeOnly && !n.breaks && hidden.has("depends")) return false;
  return true;
}

function describe(n: RadarNode): string {
  const what =
    n.kind === "changed"
      ? "changed"
      : n.kind === "deleted"
        ? "deleted"
        : `${STEP(n.distance)} away${n.kind === "route" ? ", API route" : ""}${n.runtimeOnly ? ", found only at runtime" : ""}${n.breaks ? ", will break" : ""}`;
  return `${n.id}, ${what}`;
}

function NodeBox({ n, selected }: { n: RadarNode; selected: boolean }) {
  const left = n.bx - n.w / 2;
  const top = n.by - n.h / 2;
  const dot = n.kind === "route" || n.kind === "hidden";
  const textX = dot ? left + 18 + (n.w - 18 - 8) / 2 : n.bx;
  return (
    <>
      <rect
        className={`rbox ${n.kind}${n.breaks ? " breaks" : ""}${selected ? " selected" : ""}`}
        x={left}
        y={top}
        width={n.w}
        height={n.h}
        rx={2}
      />
      {dot && <circle className={`rdot ${n.kind}`} cx={left + 10} cy={n.by} r={3} />}
      <text className={`rtext ${n.kind}`} x={textX} y={n.by + 3.5} textAnchor="middle">
        {n.text}
      </text>
      {n.caption && (
        <text className="rcaption" x={n.bx} y={n.by + n.h / 2 + 11} textAnchor="middle">
          {n.caption}
        </text>
      )}
    </>
  );
}

export function Radar({ report, hidden, variant, selected, onPick }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const width = useElementWidth(frame);
  const [zoom, setZoom] = useState(0);
  const square = width < 560;
  const height = square ? width : variant === "tall" ? 460 : Math.round(Math.min(520, Math.max(340, width * 0.66)));
  const map = useMemo(() => layoutRadar(report, width, height), [report, width, height]);
  const scale = ZOOMS[zoom];

  const shown = new Map(map.nodes.filter((n) => isShown(n, hidden)).map((n) => [n.id, n]));
  const { x: cx, y: cy } = map.center;
  const centerNode = !map.hub ? map.nodes.find((n) => n.distance === 0) : undefined;

  function onKey(e: KeyboardEvent, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(id);
    }
  }

  const routes = map.nodes.filter((n) => n.kind === "route").length;
  const runtime = map.nodes.filter((n) => n.runtimeOnly).length;
  const deleted = map.nodes.some((n) => n.kind === "deleted");
  const summary =
    `Dependency radar. ${report.affected.length} dependents on ${map.rings.length} rings, ` +
    `${routes} API routes, ${runtime} found only at runtime${deleted ? ", a deleted function in the middle" : ""}.`;

  const at = (id: string) => {
    const n = shown.get(id);
    if (!n) return null;
    return n === centerNode ? { x: cx, y: cy } : { x: n.bx, y: n.by };
  };

  return (
    <>
    <div className={`radar-frame ${variant}`} ref={frame}>
      <div className="radar-scroll">
        <svg
          width={width * scale}
          height={height * scale}
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={summary}
          className="radar"
        >
          <defs>
            <radialGradient id="radar-halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
              <stop offset="60%" stopColor="#3b82f6" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </radialGradient>
          </defs>
          <g aria-hidden="true">
            <line className="axis" x1={cx} y1={8} x2={cx} y2={height - 8} />
            <line className="axis" x1={8} y1={cy} x2={width - 8} y2={cy} />
            {map.rings.map((ring) => (
              <ellipse key={ring.distance} className="ring" cx={cx} cy={cy} rx={ring.rx} ry={ring.r} />
            ))}
            {map.rings.map((ring) => (
              <text key={`l${ring.distance}`} className="ring-label" x={ring.lx} y={ring.ly} textAnchor={ring.anchor}>
                {ring.label}
              </text>
            ))}
            {map.hub &&
              map.nodes
                .filter((n) => n.distance === 0 && shown.has(n.id))
                .map((n) => <line key={`hub-${n.id}`} className="redge hub" x1={cx} y1={cy} x2={n.bx} y2={n.by} />)}
            {map.edges.map((e) => {
              const a = at(e.from);
              const b = at(e.to);
              if (!a || !b) return null;
              return <line key={`${e.from}>${e.to}`} className={`redge ${e.style}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })}
            {map.hub && (
              <>
                <circle cx={cx} cy={cy} r={18} fill="url(#radar-halo)" />
                <circle className="hub-dot" cx={cx} cy={cy} r={5} />
              </>
            )}
            {centerNode && (
              <>
                <circle cx={cx} cy={cy} r={26} fill="url(#radar-halo)" />
                <circle className="center-ring" cx={cx} cy={cy} r={9} />
                <circle className="center-dot" cx={cx} cy={cy} r={3.5} />
              </>
            )}
          </g>

          {[...shown.values()].map((n) => (
            <g
              key={n.id}
              className="rnode"
              role="button"
              tabIndex={0}
              aria-label={`${describe(n)}. Show details.`}
              aria-pressed={selected === n.id}
              onClick={() => onPick(n.id)}
              onKeyDown={(e) => onKey(e, n.id)}
            >
              <title>{n.id}</title>
              {n.boxed ? (
                <NodeBox n={n} selected={selected === n.id} />
              ) : (
                <circle className={`rmini ${n.kind}`} cx={n.bx} cy={n.by} r={4} />
              )}
            </g>
          ))}
        </svg>
      </div>

      <div className="radar-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(z + 1, ZOOMS.length - 1))}>
          <Icon name="plus" size={16} />
        </button>
        <button type="button" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(z - 1, 0))}>
          <Icon name="minus" size={16} />
        </button>
        <button type="button" aria-label="Fit to view" disabled={zoom === 0} onClick={() => setZoom(0)}>
          <Icon name="fit" size={16} />
        </button>
      </div>

    </div>
      <ul className="radar-legend" aria-label="Legend">
        <li>
          <span className="key changed" /> Changed
        </li>
        <li>
          <span className="key depends" /> Depends on it
        </li>
        {runtime > 0 && (
          <li>
            <span className="key hidden" /> Found at runtime
          </li>
        )}
        {routes > 0 && (
          <li>
            <span className="key route" /> API route
          </li>
        )}
        {deleted && (
          <li>
            <span className="key deleted" /> Deleted
          </li>
        )}
      </ul>
    </>
  );
}
