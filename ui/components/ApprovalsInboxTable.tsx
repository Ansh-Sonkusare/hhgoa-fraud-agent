"use client";

import Link from "next/link";
import { useState } from "react";
import type { PendingApproval } from "../lib/types";
import { postApprovalDecision } from "../lib/api";
import { RouteChip } from "./StatusChip";
import { EmptyState } from "./EmptyState";

export function ApprovalsInboxTable({ pending, onDecided }: { pending: PendingApproval[]; onDecided: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(p: PendingApproval, decision: "approved" | "rejected") {
    const key = `${p.case_id}:${p.action}`;
    setBusy(key);
    try {
      await postApprovalDecision(p.case_id, p.action, decision);
      onDecided();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2 className="panel-title">Approvals inbox ({pending.length} pending)</h2>
      {pending.length === 0 ? (
        <EmptyState title="Nothing waiting on a human" hint="L1/L2 actions from active investigations show up here." />
      ) : (
        <ul className="space-y-2">
          {pending.map((p) => {
            const key = `${p.case_id}:${p.action}`;
            return (
              <li key={key} className="flex flex-wrap items-center gap-2 rounded border border-slate-100 bg-slate-50 p-3 text-sm">
                <Link href={`/cases/${encodeURIComponent(p.case_id)}`} className="font-medium text-blue-700 hover:underline">
                  {p.case_id}
                </Link>
                <RouteChip route={p.route} />
                <span className="font-medium">{p.action}</span>
                <span className="text-xs text-slate-500">{p.reason}</span>
                <span className="ml-auto flex gap-2">
                  <button
                    onClick={() => decide(p, "approved")}
                    disabled={busy === key}
                    className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(p, "rejected")}
                    disabled={busy === key}
                    className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Reject
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
