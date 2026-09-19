"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { AgentEvent, EvidenceItem } from "../lib/types";
import { EmptyState } from "./EmptyState";

// react-force-graph-2d touches `window`/canvas at import time — must be
// client-only and lazy, or `next build`'s server render pass crashes.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

interface GraphNode {
  id: string;
  type: string;
  label: string;
  suspicious: boolean;
}
interface GraphLink {
  source: string;
  target: string;
  label: string;
}

const NODE_COLOR: Record<string, string> = {
  Card: "#2563eb",
  Transaction: "#7c3aed",
  Device: "#dc2626",
  Customer: "#0891b2",
  ClosedCase: "#64748b",
  Case: "#334155",
};

function buildGraph(caseId: string, events: AgentEvent[]): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const root: GraphNode = { id: `Case:${caseId}`, type: "Case", label: caseId, suspicious: true };
  nodes.set(root.id, root);

  const addNode = (type: string, id: string, suspicious = false) => {
    const key = `${type}:${id}`;
    if (!nodes.has(key)) nodes.set(key, { id: key, type, label: id, suspicious });
    else if (suspicious) nodes.get(key)!.suspicious = true;
    return key;
  };

  for (const event of events) {
    if (event.type === "evidence_added") {
      const ev = event.payload["evidence"] as EvidenceItem | undefined;
      if (!ev) continue;
      const suspicious = ev.category !== "customer_response";
      for (const entity of ev.entities) {
        const key = addNode(entity.type, entity.id, suspicious);
        links.push({ source: root.id, target: key, label: ev.category });
      }
    }
    if (event.type === "tool_result" && event.payload["tool"] === "find_shared_entity_rings") {
      const rings =
        (event.payload["rings"] as Array<{ shared_type: string; shared_id: string; card_ids: string[] }> | undefined) ??
        ((event.payload["result"] as { rings?: Array<{ shared_type: string; shared_id: string; card_ids: string[] }> } | undefined)
          ?.rings ??
          []);
      for (const ring of rings) {
        const sharedKey = addNode(ring.shared_type, ring.shared_id, true);
        for (const cardId of ring.card_ids) {
          const cardKey = addNode("Card", cardId, true);
          links.push({ source: sharedKey, target: cardKey, label: "shares " + ring.shared_type });
        }
      }
    }
  }

  return { nodes: [...nodes.values()], links };
}

export function NeighborhoodGraph({ caseId, events }: { caseId: string; events: AgentEvent[] }) {
  const graph = useMemo(() => buildGraph(caseId, events), [caseId, events]);

  return (
    <div className="panel">
      <h2 className="panel-title">Neighborhood graph</h2>
      {graph.nodes.length <= 1 ? (
        <EmptyState title="No connected entities yet" hint="Graph evidence (shared devices, rings, cards) appears here." />
      ) : (
        <div className="h-96 w-full overflow-hidden rounded border border-slate-100">
          <ForceGraph2D
            graphData={graph}
            nodeId="id"
            nodeLabel="label"
            nodeColor={(n) => {
              const node = n as unknown as GraphNode;
              return node.suspicious ? "#dc2626" : (NODE_COLOR[node.type] ?? "#94a3b8");
            }}
            nodeVal={(n) => {
              const node = n as unknown as GraphNode;
              return node.type === "Case" ? 8 : 4;
            }}
            linkLabel="label"
            linkColor={() => "#cbd5e1"}
            width={undefined}
            height={380}
          />
        </div>
      )}
    </div>
  );
}
