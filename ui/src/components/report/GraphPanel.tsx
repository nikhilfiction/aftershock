/**
 * The call graph around one function, or how the files import each other.
 * Loaded lazily: React Flow is the heaviest dependency, and the page is
 * useful before it arrives.
 */
import "@xyflow/react/dist/style.css";

import { Background, Controls, Handle, Position, ReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { memo, useMemo } from "react";

import { useGraph } from "../../api/hooks";
import type { Report } from "../../api/types";
import { shortLabel } from "../../lib/format";
import { Icon } from "../Icon";
import { Empty, ErrorBanner, SkeletonLines } from "../ui";
import { layoutGraph, type CardData } from "./graphLayout";

type Props = {
  snapshotId: number;
  focus: string | null;
  report?: Report | null;
  onFocus: (name: string | null) => void;
  onAnalyze: (name: string) => void;
};

const Card = memo(function Card({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className={`gcard role-${data.role}`} title={`${data.name}\n${data.file}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="gcard-top">
        <span className="gcard-step">{data.step}</span>
        {data.badge && <span className={`gcard-badge ${data.badge.tone}`}>{data.badge.text}</span>}
      </div>
      <div className="gcard-name">{data.name}</div>
      <div className="gcard-file">{data.file}</div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { card: Card };

export default function GraphPanel({ snapshotId, focus, report, onFocus, onAnalyze }: Props) {
  const { data, isPending, isError, error, refetch, isFetching } = useGraph(snapshotId, focus, focus ? 3 : 1);
  const flow = useMemo(() => (data ? layoutGraph(data, report) : null), [data, report]);
  const target = report?.changed[0]?.name ?? null;

  return (
    <section className="panel graph-panel" aria-labelledby="graph-h">
      <div className="panel-head">
        <div>
          <h2 id="graph-h" className="panel-title">
            <Icon name="tree" size={20} stroke={1.8} className="c-primary" />
            {focus ? "Call graph" : "How the files fit together"}
          </h2>
          <p className="soft small">
            {focus ? (
              <>
                What calls <code className="c-primary">{shortLabel(focus)}</code> is drawn above it, what it uses below.
                Click a box to move there.
              </>
            ) : (
              "Each box is a file; arrows point from a file to the files it imports. Click one to look inside."
            )}
          </p>
        </div>
        <div className="row-gap">
          {isFetching && !isPending && <span className="spinner" aria-label="Updating graph" />}
          {focus && target && focus !== target && (
            <button type="button" className="btn small" onClick={() => onFocus(target)}>
              Back to {shortLabel(target)}
            </button>
          )}
          {focus && (
            <button type="button" className="btn small" onClick={() => onFocus(null)}>
              All files
            </button>
          )}
          {focus && focus !== target && (
            <button type="button" className="btn small primary" onClick={() => onAnalyze(focus)}>
              Blast radius of this
            </button>
          )}
        </div>
      </div>

      <div className="graph-canvas">
        {isPending && <SkeletonLines rows={6} height={28} />}
        {isError && <ErrorBanner error={error} onRetry={() => refetch()} />}
        {flow && flow.nodes.length === 0 && <Empty title="Nothing to draw">This scan found no code files.</Empty>}
        {flow && flow.nodes.length > 0 && (
          <ReactFlow
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onFocus(node.id)}
            nodesDraggable={false}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
            minZoom={0.15}
            colorMode="dark"
            // remount when the drawn data changes, so fitView sizes to the new graph
            // (keepPreviousData would otherwise fit the old one and never refit)
            key={`${data?.focus ?? "modules"}-${flow.nodes.length}`}
          >
            <Background gap={24} color="#222734" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {data?.truncated && <p className="notice warn">A large neighbourhood: showing the 300 symbols closest to the focus.</p>}

      <ul className="graph-legend label quiet" aria-label="Legend">
        <li>
          <span className="line static" /> Read from code
        </li>
        <li>
          <span className="line both" /> Confirmed at runtime
        </li>
        <li>
          <span className="line dynamic" /> Only at runtime
        </li>
        <li>
          <span className="box changed" /> Changed
        </li>
      </ul>
    </section>
  );
}
