import type { AnswerFile } from "../lib/types";
import { RiskChip, VerdictChip } from "./StatusChip";

export function CaseHeader({
  caseId,
  state,
  answer,
  latestRiskLevel,
  latestConfidence,
  openedAt,
  triggerType,
  triggerText,
}: {
  caseId: string;
  state: string | null;
  answer: AnswerFile | null;
  latestRiskLevel: string | null;
  latestConfidence: number | null;
  openedAt?: string | null;
  triggerType?: string | null;
  triggerText?: string | null;
}) {
  const pattern = answer?.case.pattern ?? null;
  const verdict = answer?.case.verdict ?? null;
  const exposure = answer?.case.exposure_usd ?? null;

  return (
    <div className="panel flex flex-wrap items-center gap-4">
      <div>
        <h1 className="text-lg font-semibold">{caseId}</h1>
        <p className="text-xs text-slate-500">
          {state ? `state: ${state}` : "not started"}
          {answer ? ` · status: ${answer.case.status}` : ""}
          {openedAt ? ` · opened ${openedAt.replace("T", " ").replace("Z", "")}` : ""}
          {triggerType ? ` · trigger: ${triggerType}` : ""}
        </p>
        {triggerText ? (
          <p className="mt-1 max-w-3xl text-xs text-slate-400">{triggerText}</p>
        ) : null}
      </div>
      <VerdictChip verdict={verdict} />
      <RiskChip level={latestRiskLevel} />
      {pattern ? (
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700">
          {pattern}
        </span>
      ) : null}
      {latestConfidence !== null ? (
        <span className="text-xs text-slate-500">confidence {latestConfidence.toFixed(2)}</span>
      ) : null}
      {exposure !== null ? (
        <span className="text-xs text-slate-500">exposure ${exposure.toFixed(2)}</span>
      ) : null}
    </div>
  );
}