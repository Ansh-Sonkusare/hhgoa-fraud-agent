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
      {error ? <ErrorState message={error} /> : null}
      {pending ? <ApprovalsInboxTable pending={pending} onDecided={load} /> : <p className="text-sm text-slate-500">Loading…</p>}
    </div>
  );
}
