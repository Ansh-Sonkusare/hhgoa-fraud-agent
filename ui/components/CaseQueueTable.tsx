"use client";

import Link from "next/link";
import type { CaseListItem } from "../lib/types";
import { StatusChip, VerdictChip } from "./StatusChip";

const SOURCE_LABEL: Record<string, string> = {
  case_pack: "benchmark",
  fixture_demo: "fixture demo",
  adhoc: "new trigger",
};

export function CaseQueueTable({ cases }: { cases: CaseListItem[] }) {
  return (
    <div className="panel overflow-x-auto">
      <h2 className="panel-title">Case queue ({cases.length})</h2>
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
            <th className="py-2 pr-3">Case</th>
            <th className="py-2 pr-3">Source</th>
            <th className="py-2 pr-3">Trigger</th>
            <th className="py-2 pr-3">Opened</th>
            <th className="py-2 pr-3">Risk score</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Verdict</th>
            <th className="py-2 pr-3">P(fraud)</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.case_id} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="py-2 pr-3 font-medium">
                <Link href={`/cases/${encodeURIComponent(c.case_id)}`} className="text-blue-700 hover:underline">
                  {c.case_id}
                </Link>
              </td>
              <td className="py-2 pr-3 text-slate-500">{SOURCE_LABEL[c.source] ?? c.source}</td>
              <td className="py-2 pr-3 text-slate-600">{c.trigger_type}</td>
              <td className="py-2 pr-3 text-slate-500">{c.opened_at ? c.opened_at.replace("T", " ").replace("Z", "") : "—"}</td>
              <td className="py-2 pr-3">{c.risk_score !== null ? c.risk_score.toFixed(2) : "—"}</td>
              <td className="py-2 pr-3">
                <StatusChip status={c.status} />
              </td>
              <td className="py-2 pr-3">
                <VerdictChip verdict={c.verdict} />
              </td>
              <td className="py-2 pr-3">{c.fraud_probability !== null ? c.fraud_probability.toFixed(2) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
