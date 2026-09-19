"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchApprovals } from "../../lib/api";
import type { PendingApproval } from "../../lib/types";
import { ApprovalsInboxTable } from "../../components/ApprovalsInboxTable";
import { ErrorState } from "../../components/EmptyState";

export default function ApprovalsPage() {
  const [pending, setPending] = useState<PendingApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchApprovals()
      .then(setPending)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Approvals inbox</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          L1/L2 actions that need a human decision before the agent executes them.
        </p>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {pending ? <ApprovalsInboxTable pending={pending} onDecided={load} /> : <p className="text-sm text-slate-500">Loading…</p>}
    </div>
  );
}
