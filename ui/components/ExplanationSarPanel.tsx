import type { Sar } from "../lib/types";
import { EmptyState } from "./EmptyState";

export interface ExplanationPayload {
  evidence_used: string[];
  why_more_evidence: string | null;
  why_actions: Record<string, string>;
  remaining_uncertainty: string;
  what_would_change_the_decision: string;
}

export function ExplanationSarPanel({ explanation, sar }: { explanation: ExplanationPayload | null; sar: Sar | null }) {
  return (
    <div className="panel space-y-4">
      <h2 className="panel-title">Explanation and SAR</h2>

      {!explanation ? (
        <EmptyState title="No explanation yet" />
      ) : (
        <div className="space-y-3 text-sm">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Evidence used</h3>
            <ul className="list-disc space-y-0.5 pl-5">
              {explanation.evidence_used.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
          {explanation.why_more_evidence ? (
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Why more evidence</h3>
              <p>{explanation.why_more_evidence}</p>
            </div>
          ) : null}
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Why these actions</h3>
            <ul className="space-y-0.5">
              {Object.entries(explanation.why_actions).map(([action, reason]) => (
                <li key={action}>
                  <span className="font-medium">{action}:</span> {reason}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Remaining uncertainty</h3>
            <p>{explanation.remaining_uncertainty}</p>
          </div>
        </div>
      )}

      <div className="border-t border-slate-100 pt-3">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Suspicious activity report
        </h3>
        {!sar || !sar.file ? (
          <p className="text-sm text-slate-500">{sar ? sar.reason : "Not yet determined."}</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-xs text-slate-500">{sar.reason}</p>
            <p className="whitespace-pre-wrap">{sar.narrative}</p>
            <p className="text-xs text-slate-500">
              subjects: {sar.subjects.join(", ")} · total ${sar.total_amount_usd.toFixed(2)} · {sar.activity_dates.join(" to ")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
