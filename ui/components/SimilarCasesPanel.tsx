import type { EvidenceItem } from "../lib/types";
import { EmptyState } from "./EmptyState";

export function SimilarCasesPanel({
  evidence,
  similarPriorCases,
}: {
  evidence: EvidenceItem[];
  similarPriorCases: string[] | null;
}) {
  const priorCaseEvidence = evidence.filter((e) => e.category === "prior_cases");
  const ids =
    similarPriorCases ??
    [...new Set(priorCaseEvidence.flatMap((e) => e.entities.filter((en) => en.type === "ClosedCase").map((en) => en.id)))];

  return (
    <div className="panel">
      <h2 className="panel-title">Similar prior cases ({ids.length})</h2>
      {ids.length === 0 ? (
        <EmptyState title="No similar prior cases retrieved" hint="Case memory (rag/) found nothing overlapping yet." />
      ) : (
        <ul className="space-y-2">
          {ids.map((id) => {
            const overlap = priorCaseEvidence.find((e) => e.entities.some((en) => en.id === id));
            return (
              <li key={id} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm">
                <p className="font-medium">{id}</p>
                {overlap ? <p className="text-xs text-slate-500">{overlap.summary}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
