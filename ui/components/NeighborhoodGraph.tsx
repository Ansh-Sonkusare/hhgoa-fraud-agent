"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Network } from "lucide-react";
import type { AgentEvent } from "../lib/types";
import { buildGraph, MAX_CARDS_PER_GROUP } from "../lib/neighborhoodGraph";
import { EmptyState } from "./EmptyState";

// react-force-graph-2d touches `window`/canvas at import time — must be
// client-only and lazy, or `next build`'s server render pass crashes.
const ForceGraphView = dynamic(() => import("./ForceGraphView"), { ssr: false });

const HEIGHT = 380;
const LEGEND: Array<[string, string]> = [
  ["Case", "#334155"],
  ["Card", "#2563eb"],
  ["Device", "#ea580c"],
  ["Address", "#0d9488"],
  ["EmailDomain", "#f43f5e"],
  ["Transaction", "#7c3aed"],
  ["Customer", "#0891b2"],
  ["ClosedCase", "#64748b"],
];

export function NeighborhoodGraph({ caseId, events }: { caseId: string; events: AgentEvent[] }) {
  const graph = useMemo(() => buildGraph(caseId, events), [caseId, events]);
  const hasGraph = graph.links.length > 0;

  // Measure the panel: the canvas must be sized to it, not to the window.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasGraph]);

  const present = new Set(graph.nodes.map((n) => n.type));

  return (
    <div className="panel">
      <h2 className="panel-title">
        <Network size={14} /> Neighborhood graph
      </h2>
      {!hasGraph ? (
        <EmptyState title="No connected entities yet" hint="Graph evidence (shared devices, rings, cards) appears here." />
      ) : (
        <>
          <div ref={wrapRef} className="w-full overflow-hidden rounded border border-slate-100" style={{ height: HEIGHT }}>
            {width > 0 ? <ForceGraphView graph={graph} width={width} height={HEIGHT} /> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            {LEGEND.filter(([type]) => present.has(type)).map(([type, color]) => (
              <span key={type} className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                {type}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#dc2626" }} />
              flagged
            </span>
          </div>
          {graph.hiddenCards > 0 || graph.hiddenEntities > 0 ? (
            <p className="mt-1 text-xs text-slate-400">
              Large shared groups are capped at {MAX_CARDS_PER_GROUP} cards for readability
              {graph.hiddenCards > 0 ? `: ${graph.hiddenCards} more cards in those groups are not drawn` : ""}
              {graph.hiddenEntities > 0 ? `; ${graph.hiddenEntities} more entities listed in the evidence are not drawn` : ""}
              . Hover a node for details; the full lists are in Evidence used.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
