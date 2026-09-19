import { Loader2 } from "lucide-react";
import type { AnswerFile } from "../lib/types";
import { RiskChip, StatusChip, VerdictChip } from "./StatusChip";

export function CaseHeader({
  caseId,
  state,
  status,
  answer,
  latestRiskLevel,
  latestConfidence,
  openedAt,
  triggerType,
  triggerText,
}: {
  caseId: string;
  state: string | null;
  status?: string | null;
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
  const running = status === "running";

  return (
    <div className="panel flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold">{caseId}</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          {openedAt ? (
            <>
              opened {new Date(openedAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </>
          ) : (
            "opened now"
          )}
          {triggerType ? ` · trigger: ${triggerType}` : ""}
        </p>
        {triggerText ? <p className="mt-1 max-w-3xl truncate text-xs text-slate-400" title={triggerText}>{triggerText}</p> : null}
      </div>

      {running ? (
        <span className="chip border-blue-200 bg-blue-50 text-blue-800">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-xs">{state ?? "running"}</span>
        </span>
      ) : state ? (
        <StatusChip status={status ?? "idle"} />
      ) : null}

      <VerdictChip verdict={verdict} />
      <RiskChip level={latestRiskLevel} />
      {pattern ? (
        <span className="chip border-slate-200 bg-slate-50 text-slate-700">{pattern}</span>
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