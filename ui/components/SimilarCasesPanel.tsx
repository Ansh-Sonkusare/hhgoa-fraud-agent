import { Fragment } from "react";
import { Layers } from "lucide-react";
import type { EvidenceItem } from "../lib/types";
import { EmptyState } from "./EmptyState";

/** Pattern lists join with "/" and never wrap on their own; offer a break after each slash. */
function breakAfterSlashes(text: string) {
  return text.split("/").map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? (
        <>
          /<wbr />
        </>
      ) : null}
      {part}
    </Fragment>
  ));
}

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
      <h2 className="panel-title">
        <Layers size={14} /> Similar prior cases <span className="font-normal normal-case text-slate-400">({ids.length})</span>
      </h2>
      {ids.length === 0 ? (
        <EmptyState title="No similar prior cases retrieved" hint="Case memory (rag/) found nothing overlapping yet." />
      ) : (
        <ul className="space-y-2">
          {ids.map((id) => {
            const overlap = priorCaseEvidence.find((e) => e.entities.some((en) => en.id === id));
            return (
              <li key={id} className="rounded border border-slate-100 bg-slate-50 p-2 text-sm [overflow-wrap:anywhere]">
                <p className="font-medium">{id}</p>
                {overlap ? <p className="text-xs text-slate-500">{breakAfterSlashes(overlap.summary)}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
