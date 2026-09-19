import type { AgentEvent } from "../lib/types";

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

const TYPE_LABEL: Record<string, string> = {
  state_entered: "State",
  tool_call: "Tool call",
  tool_result: "Tool result",
  evidence_added: "Evidence",
  assessment_updated: "Assessment",
  evidence_requested: "Evidence requested",
  approval_requested: "Approval requested",
  action_result: "Action",
  explanation: "Explanation",
  memory_written: "Memory write",
  done: "Done",
  error: "Error",
};

const TYPE_DOT: Record<string, string> = {
  state_entered: "bg-slate-400",
  tool_call: "bg-slate-300",
  tool_result: "bg-slate-300",
  evidence_added: "bg-blue-500",
  assessment_updated: "bg-purple-500",
  evidence_requested: "bg-amber-500",
  approval_requested: "bg-amber-600",
  action_result: "bg-emerald-500",
  explanation: "bg-indigo-500",
  memory_written: "bg-teal-500",
  done: "bg-slate-900",
  error: "bg-red-600",
};

function describeEvent(event: AgentEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "state_entered":
      return `Entered ${event.state}`;
    case "tool_call":
      return `Called ${str(p["tool"], "tool")}`;
    case "tool_result":
      return `${str(p["tool"], "tool")} returned`;
    case "evidence_added": {
      const ev = p["evidence"] as { summary?: string } | undefined;
      return ev?.summary ?? "Evidence added";
    }
    case "assessment_updated": {
      const a = p["assessment"] as { risk_level?: string; confidence?: number } | undefined;
      return a ? `risk ${a.risk_level ?? "?"}, confidence ${a.confidence?.toFixed(2) ?? "?"}` : "Assessment updated";
    }
    case "evidence_requested":
      return `${str(p["type"], "evidence")} — ${str(p["reason"])}`;
    case "approval_requested":
      return `${str(p["action"], "action")} (${str(p["route"], "route")}) — ${str(p["reason"])}`;
    case "action_result":
      return `${str(p["action"], "action")}: ${str(p["result"], "?")}${p["synthetic"] ? " (via UI approval)" : ""}`;
    case "explanation":
      return "Explanation generated";
    case "memory_written":
      return `Written to graph as ${str(p["graph_case_id"], "?")}`;
    case "done":
      return str(p["stop_reason"], "Investigation complete");
    case "error":
      return str(p["message"], "Error");
    default:
      return event.type;
  }
}

export function Timeline({ events }: { events: AgentEvent[] }) {
  return (
    <div className="panel">
      <h2 className="panel-title">Live investigation timeline ({events.length} events)</h2>
      <ol className="max-h-[32rem] space-y-2 overflow-y-auto pr-1 text-sm">
        {events.map((event) => (
          <li key={`${event.seq}-${event.type}`} className="flex items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${TYPE_DOT[event.type] ?? "bg-slate-400"}`} />
            <div>
              <p className="text-xs text-slate-400">
                #{event.seq} · {TYPE_LABEL[event.type] ?? event.type} · {event.state}
              </p>
              <p className="text-slate-800">{describeEvent(event)}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
