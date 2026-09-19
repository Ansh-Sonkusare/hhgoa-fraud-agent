"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { CaseListItem } from "../lib/types";
import { RiskChip, StatusChip, VerdictChip } from "./StatusChip";

const SOURCE_LABEL: Record<string, string> = {
  case_pack: "benchmark",
  fixture_demo: "fixture demo",
  adhoc: "new trigger",
};

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Meter({ value, tone }: { value: number | null; tone: "blue" | "red" }) {
  if (value === null) return <span className="text-slate-300">—</span>;
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const color = tone === "red" ? "bg-red-500" : "bg-blue-500";
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs tabular-nums text-slate-500">{value.toFixed(2)}</span>
    </span>
  );
}

export function CaseQueueTable({ cases }: { cases: CaseListItem[] }) {
  return (
    <div className="panel overflow-x-auto !p-0">
      <h2 className="panel-title px-4 pt-4">
        Case queue <span className="font-normal normal-case text-slate-400">({cases.length} cases — open one to investigate)</span>
      </h2>
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
            <th className="py-2.5 pl-4 pr-3 font-medium">Case</th>
            <th className="py-2.5 pr-3 font-medium">Source</th>
            <th className="py-2.5 pr-3 font-medium">Trigger</th>
            <th className="py-2.5 pr-3 font-medium">Opened</th>
            <th className="py-2.5 pr-3 font-medium">Risk</th>
            <th className="py-2.5 pr-3 font-medium">Status</th>
            <th className="py-2.5 pr-3 font-medium">Verdict</th>
            <th className="py-2.5 pr-3 font-medium">P(fraud)</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {cases.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
                No cases yet. Create one with the trigger form above.
              </td>
            </tr>
          ) : (
            cases.map((c) => (
              <tr key={c.case_id} className="group border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50">
                <td className="py-2.5 pl-4 pr-3">
                  <Link href={`/cases/${encodeURIComponent(c.case_id)}`} className="font-medium text-blue-700 hover:underline">
                    {c.case_id}
                  </Link>
                </td>
                <td className="py-2.5 pr-3">
                  <span className="chip border-slate-200 bg-slate-50 text-slate-600">{SOURCE_LABEL[c.source] ?? c.source}</span>
                </td>
                <td className="py-2.5 pr-3 text-slate-600">{c.trigger_type}</td>
                <td className="py-2.5 pr-3 whitespace-nowrap text-slate-500">{fmtDate(c.opened_at)}</td>
                <td className="py-2.5 pr-3">
                  <Meter value={c.risk_score} tone="blue" />
                </td>
                <td className="py-2.5 pr-3">
                  <StatusChip status={c.status} />
                </td>
                <td className="py-2.5 pr-3">
                  <VerdictChip verdict={c.verdict} />
                </td>
                <td className="py-2.5 pr-3">
                  <Meter value={c.fraud_probability} tone="red" />
                </td>
                <td className="py-2.5 pr-2 text-right">
                  <ChevronRight size={15} className="text-slate-300 transition group-hover:text-slate-500" />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}