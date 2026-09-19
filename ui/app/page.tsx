"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, CheckCircle2, FlaskConical, ShieldAlert } from "lucide-react";
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

  const done = cases?.filter((c) => c.status === "done" || c.status === "error").length ?? 0;
  const fraud = cases?.filter((c) => c.verdict === "fraud").length ?? 0;
  const running = cases?.filter((c) => c.status === "running").length ?? 0;

  const stats = [
    { label: "Cases", value: cases?.length ?? "…", icon: Activity, tone: "text-slate-500" },
    { label: "Investigated", value: done, icon: CheckCircle2, tone: "text-emerald-600" },
    { label: "Fraud detected", value: fraud, icon: ShieldAlert, tone: "text-red-600" },
    { label: "Running", value: running, icon: FlaskConical, tone: "text-blue-600" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Fraud case queue</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          The IEEE-CIS benchmark set — open a case to start the live agent&apos;s investigation.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="panel flex items-center gap-3 !p-3">
            <Icon size={18} className={tone} />
            <div>
              <p className="text-lg font-semibold leading-tight text-slate-900">{value}</p>
              <p className="text-xs text-slate-500">{label}</p>
            </div>
          </div>
        ))}
      </div>

      <NewTriggerForm
        onCreated={(caseId) => {
          load();
          router.push(`/cases/${encodeURIComponent(caseId)}`);
        }}
      />
      {error ? <ErrorState message={error} /> : null}
      {cases ? <CaseQueueTable cases={cases} /> : (
        <div className="panel space-y-3">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-10 w-full" />
          <div className="skeleton h-10 w-full" />
          <div className="skeleton h-10 w-full" />
        </div>
      )}
    </div>
  );
}