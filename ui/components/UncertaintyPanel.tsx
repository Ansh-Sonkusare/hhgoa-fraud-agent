import { Gauge } from "lucide-react";
import type { Assessment } from "../lib/types";
import { EmptyState } from "./EmptyState";

export function UncertaintyPanel({
  assessment,
  whatWouldChange,
}: {
  assessment: Assessment | null;
  whatWouldChange: string | null;
}) {
  return (
    <div className="panel">
      <h2 className="panel-title">
        <Gauge size={14} /> Uncertainty
      </h2>
      {!assessment ? (
        <EmptyState title="No assessment yet" hint="The agent hasn't produced a hypothesis ranking yet." />
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            {assessment.hypotheses.map((h) => (
              <div key={h.fraud_type}>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{h.fraud_type}</span>
                  <span>{(h.probability * 100).toFixed(0)}%</span>
                </div>
                <div className="h-2 w-full rounded bg-slate-100">
                  <div
                    className="h-2 rounded bg-slate-700"
                    style={{ width: `${Math.round(h.probability * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-500">
            confidence {assessment.confidence.toFixed(2)} · risk {assessment.risk_level} (score {assessment.risk_score.toFixed(2)})
          </p>

          {assessment.sufficiency.missing.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Missing evidence</h3>
              <ul className="space-y-1 text-sm">
                {assessment.sufficiency.missing.map((m) => (
                  <li key={m.what} className="rounded border border-amber-100 bg-amber-50 p-2">
                    <p className="text-slate-800">{m.what}</p>
                    <p className="text-xs text-slate-500">{m.why}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {whatWouldChange ? (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                What would change the decision
              </h3>
              <p className="text-sm text-slate-700">{whatWouldChange}</p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
