import { Search } from "lucide-react";
import type { EvidenceItem } from "../lib/types";
import { EmptyState } from "./EmptyState";

const CATEGORY_LABEL: Record<string, string> = {
  graph_structure: "Graph structure",
  txn_behavior: "Transaction behavior",
  device_identity: "Device / identity",
  prior_cases: "Prior cases",
  policy_match: "Policy match",
  external: "External",
  customer_response: "Customer response",
};

export function EvidencePanel({ evidence }: { evidence: EvidenceItem[] }) {
  const byCategory = new Map<string, EvidenceItem[]>();
  for (const item of evidence) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  return (
    <div className="panel">
      <h2 className="panel-title">
        <Search size={14} /> Evidence <span className="font-normal normal-case text-slate-400">({evidence.length})</span>
      </h2>
      {evidence.length === 0 ? (
        <EmptyState title="No evidence gathered yet" hint="Evidence appears here as the agent investigates." />
      ) : (
        <div className="space-y-4">
          {[...byCategory.entries()].map(([category, items]) => (
            <div key={category}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {CATEGORY_LABEL[category] ?? category}
              </h3>
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.id} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm">
                    <p className="text-slate-800">{item.summary}</p>
                    <p className="mt-1 flex flex-wrap gap-1 text-xs text-slate-400">
                      {item.entities.map((e) => (
                        <span key={`${e.type}:${e.id}`} className="rounded bg-white px-1.5 py-0.5 border border-slate-200">
                          {e.type}:{e.id}
                        </span>
                      ))}
                      {item.supports.length > 0 && <span className="text-emerald-600">supports: {item.supports.join(", ")}</span>}
                      {item.contradicts.length > 0 && <span className="text-red-600">contradicts: {item.contradicts.join(", ")}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
