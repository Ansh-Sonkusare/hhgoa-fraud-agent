"use client";

import { useEffect, useRef } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphNode, NeighborhoodGraphData } from "../lib/neighborhoodGraph";

export const NODE_COLOR: Record<string, string> = {
  Case: "#334155",
  Card: "#2563eb",
  Transaction: "#7c3aed",
  Device: "#ea580c",
  Address: "#0d9488",
  EmailDomain: "#f43f5e",
  Customer: "#0891b2",
  ClosedCase: "#64748b",
};
const FALLBACK_COLOR = "#94a3b8";
const FLAGGED_OUTLINE = "#dc2626";

const radius = (n: GraphNode): number => (n.role === "root" ? 8 : n.role === "flagged" || n.role === "hub" ? 6 : 3.5);

/**
 * The force graph itself, split out of NeighborhoodGraph so it can hold a ref:
 * `next/dynamic` does not forward refs, and we need one to fit the view to the
 * laid-out graph. Without an explicit width the library sizes the canvas to the
 * browser window, which is wider than the panel, so on a wide screen the graph
 * was centred outside the visible area and the panel looked empty.
 */
export default function ForceGraphView({ graph, width, height }: { graph: NeighborhoodGraphData; width: number; height: number }) {
  const fg = useRef<ForceGraphMethods | undefined>(undefined);

  useEffect(() => {
    fg.current?.d3Force("charge")?.strength(-70);
    fg.current?.d3Force("link")?.distance?.(28);
  }, []);

  // Re-fit when the panel is resized or the graph changes.
  useEffect(() => {
    const t = setTimeout(() => fg.current?.zoomToFit(200, 30), 400);
    return () => clearTimeout(t);
  }, [width, graph]);

  return (
    <ForceGraph2D
      ref={fg}
      graphData={graph}
      width={width}
      height={height}
      nodeId="id"
      nodeRelSize={1}
      nodeVal={(n) => radius(n as unknown as GraphNode) ** 2}
      nodeLabel={(n) => {
        const node = n as unknown as GraphNode;
        return `${node.type} ${node.label}${node.hidden ? ` (+${node.hidden} more cards not drawn)` : ""}`;
      }}
      linkLabel="label"
      linkColor={() => "#cbd5e1"}
      cooldownTicks={120}
      onEngineStop={() => fg.current?.zoomToFit(300, 30)}
      nodeCanvasObject={(n, ctx, globalScale) => {
        const node = n as unknown as GraphNode & { x: number; y: number };
        const r = radius(node);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = NODE_COLOR[node.type] ?? FALLBACK_COLOR;
        ctx.fill();
        if (node.flagged) {
          ctx.lineWidth = 2 / globalScale;
          ctx.strokeStyle = FLAGGED_OUTLINE;
          ctx.stroke();
        }
        if (node.role !== "leaf") {
          const text = node.hidden ? `${node.label} (+${node.hidden} more)` : node.label;
          ctx.font = `${11 / globalScale}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = "#334155";
          ctx.fillText(text, node.x, node.y + r + 2 / globalScale);
        }
      }}
    />
  );
}
