import { MessageCircleQuestion } from "lucide-react";
import type { AgentEvent } from "../lib/types";
import { EmptyState } from "./EmptyState";

interface EvidenceRequestInfo {
  seq: number;
  type: string;
  target: string;
  reason: string;
  discrimination_score: number | null;
  response: string | null;
  settled: boolean;
}

/**
 * Renders the evidence-request lifecycle (PRD §9.6 / J6 demo beat): what the
 * agent asked for, who it asked, and — once the (simulated) response arrives
 * as the tool_result to `request_evidence` — what it assumed the response
 * was. "Settled" means the response has arrived, so the panel can say the
 * request is no longer blocking the decision.
 */
export function EvidenceRequestPanel({ events }: { events: AgentEvent[] }) {
  const requests: EvidenceRequestInfo[] = [];
  for (const event of events) {
    if (event.type === "evidence_requested") {
      const target = event.payload["target"] as { type?: string; id?: string } | undefined;
      requests.push({
        seq: event.seq,
        type: String(event.payload["type"] ?? "evidence"),
        target: target ? `${target.type}:${target.id}` : "—",
        reason: String(event.payload["reason"] ?? ""),
        discrimination_score:
          typeof event.payload["discrimination_score"] === "number"
            ? (event.payload["discrimination_score"] as number)
            : null,
        response: null,
        settled: false,
      });
    }
    if (event.type === "tool_result" && event.payload["tool"] === "request_evidence") {
      const result = event.payload["result"] as
        | { responded?: boolean; response_text?: string }
        | undefined;
      const lastOpen = [...requests].reverse().find((r) => !r.settled);
      if (lastOpen) {
        lastOpen.response = String(result?.response_text ?? result?.responded ?? "");
        lastOpen.settled = true;
      }
    }
  }

  return (
    <div className="panel">
      <h2 className="panel-title">
        <MessageCircleQuestion size={14} /> Evidence requests <span className="font-normal normal-case text-slate-400">({requests.length})</span>
      </h2>
      {requests.length === 0 ? (
        <EmptyState title="No evidence requested" hint="R1/R3-tier requests (customer validation, step-up auth, analyst info) appear here." />
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => (
            <li key={r.seq} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm">
              <p className="flex items-center gap-2">
                <span className="font-medium">{r.type}</span>
                <span className="text-xs text-slate-500">→ {r.target}</span>
              </p>
              {r.discrimination_score !== null ? (
                <p className="text-xs text-slate-500">
                  discrimination {r.discrimination_score.toFixed(2)}
                </p>
              ) : null}
              <p className="text-xs text-slate-500">{r.reason}</p>
              {r.settled ? (
                <p className="mt-1 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                  Assumed response: {r.response}
                </p>
              ) : (
                <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  Awaiting response…
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}