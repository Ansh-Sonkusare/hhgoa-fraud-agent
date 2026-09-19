"use client";

import { useMemo, useState } from "react";
import type { AgentEvent, AnswerFile, NextBestAction } from "../lib/types";
import { postApprovalDecision } from "../lib/api";
import { RouteChip } from "./StatusChip";
import { EmptyState } from "./EmptyState";

interface LiveAction {
  action: string;
  route: string;
  reason: string;
  status: "PENDING_APPROVAL" | "EXECUTED" | "DENIED";
}

function deriveLiveActions(events: AgentEvent[]): LiveAction[] {
  const byAction = new Map<string, LiveAction>();
  for (const event of events) {
    if (event.type === "approval_requested") {
      const action = String(event.payload["action"] ?? "unknown");
      byAction.set(action, {
        action,
        route: String(event.payload["route"] ?? "?"),
        reason: String(event.payload["reason"] ?? ""),
        status: "PENDING_APPROVAL",
      });
    }
    if (event.type === "action_result") {
      const action = String(event.payload["action"] ?? "unknown");
      const result = String(event.payload["result"] ?? "EXECUTED");
      const existing = byAction.get(action);
      byAction.set(action, {
        action,
        route: existing?.route ?? "auto",
        reason: existing?.reason ?? "",
        status: result === "DENIED" ? "DENIED" : "EXECUTED",
      });
    }
  }
  return [...byAction.values()];
}

function ActionTable({ title, actions }: { title: string; actions: NextBestAction[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      <ul className="space-y-1">
        {actions.map((a, i) => (
          <li key={`${a.action}-${i}`} className="flex items-center gap-2 rounded border border-slate-100 bg-slate-50 p-2 text-sm">
            <RouteChip route={a.route} />
            <span className="font-medium">{a.action}</span>
            <span className="text-xs text-slate-500">{a.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ActionsPanel({
  caseId,
  events,
  answer,
  onDecided,
}: {
  caseId: string;
  events: AgentEvent[];
  answer: AnswerFile | null;
  onDecided: () => void;
}) {
  const liveActions = useMemo(() => deriveLiveActions(events), [events]);
  // Optimistic overlay for decisions a human just made. Server truth reflows
  // into `liveActions` on an open SSE stream (the synthetic action_result
  // broadcast) or on the next visit (the backlog replay includes it), but
  // for a reloaded, already-finished case the stream is closed — this local
  // record keeps the chip correct immediately and powers the reconcile in
  // onDecided below.
  const [decided, setDecided] = useState<Record<string, "approved" | "rejected">>({});
  const [pendingSubmit, setPendingSubmit] = useState<string | null>(null);

  const actionsWithDecisions = useMemo(
    () =>
      liveActions.map((a): LiveAction => {
        const local = decided[a.action];
        if (!local) return a;
        return { ...a, status: local === "approved" ? "EXECUTED" : "DENIED" };
      }),
    [liveActions, decided],
  );

  async function decide(action: string, decision: "approved" | "rejected") {
    setPendingSubmit(action);
    try {
      await postApprovalDecision(caseId, action, decision);
      setDecided((current) => ({ ...current, [action]: decision }));
      onDecided();
    } finally {
      setPendingSubmit(null);
    }
  }

  return (
    <div className="panel space-y-4">
      <h2 className="panel-title">Recommended actions</h2>

      {liveActions.length === 0 ? (
        <EmptyState title="No actions recommended yet" />
      ) : (
        <ul className="space-y-1">
          {actionsWithDecisions.map((a) => (
            <li key={a.action} className="flex flex-wrap items-center gap-2 rounded border border-slate-100 bg-slate-50 p-2 text-sm">
              <RouteChip route={a.route} />
              <span className="font-medium">{a.action}</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  a.status === "EXECUTED"
                    ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                    : a.status === "DENIED"
                      ? "border-red-200 bg-red-100 text-red-800"
                      : "border-amber-200 bg-amber-100 text-amber-800"
                }`}
              >
                {a.status}
              </span>
              <span className="text-xs text-slate-500">{a.reason}</span>
              {a.status === "PENDING_APPROVAL" && (
                <span className="ml-auto flex gap-2">
                  <button
                    onClick={() => decide(a.action, "approved")}
                    disabled={pendingSubmit === a.action}
                    className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(a.action, "rejected")}
                    disabled={pendingSubmit === a.action}
                    className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Reject
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {answer ? (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <ActionTable title="Initial (before evidence)" actions={answer.next_best_actions.initial} />
          <ActionTable title="Final (after evidence)" actions={answer.next_best_actions.final} />
          <p className="text-xs text-slate-500">
            <span className="font-semibold">What changed: </span>
            {answer.next_best_actions.what_changed}
          </p>
        </div>
      ) : null}
    </div>
  );
}
