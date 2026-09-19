"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchCases } from "../lib/api";
import type { CaseListItem } from "../lib/types";
import { CaseQueueTable } from "../components/CaseQueueTable";
import { NewTriggerForm } from "../components/NewTriggerForm";
import { ErrorState } from "../components/EmptyState";

export default function CaseQueuePage() {
  const [cases, setCases] = useState<CaseListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(() => {
    fetchCases()
      .then(setCases)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
    // Poll so cases started from other tabs (or the fixture auto-start on
    // first case-detail visit) show updated status here too.
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-6">
      <NewTriggerForm
        onCreated={(caseId) => {
          load();
          router.push(`/cases/${encodeURIComponent(caseId)}`);
        }}
      />
      {error ? <ErrorState message={error} /> : null}
      {cases ? <CaseQueueTable cases={cases} /> : <p className="text-sm text-slate-500">Loading cases…</p>}
    </div>
  );
}
