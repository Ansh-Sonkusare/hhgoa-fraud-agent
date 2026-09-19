"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, HelpCircle, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { fetchCaseDetail, subscribeToCaseEvents } from "../lib/api";
import type {
  AgentEvent,
  AnswerFile,
  Assessment,
  EvidenceItem,
} from "../lib/types";
import { CaseHeader } from "./CaseHeader";
import { Timeline } from "./Timeline";
import { EvidencePanel } from "./EvidencePanel";
import { NeighborhoodGraph } from "./NeighborhoodGraph";
import { UncertaintyPanel } from "./UncertaintyPanel";
import { EvidenceRequestPanel } from "./EvidenceRequestPanel";
import { ActionsPanel } from "./ActionsPanel";
import { SimilarCasesPanel } from "./SimilarCasesPanel";
import { ExplanationSarPanel, type ExplanationPayload } from "./ExplanationSarPanel";
import { ErrorState } from "./EmptyState";

const VERDICT_BANNER = {
  fraud: { label: "Fraud confirmed", icon: ShieldAlert, classes: "border-red-200 bg-red-50 text-red-900" },
  legitimate: { label: "Legitimate activity", icon: ShieldCheck, classes: "border-emerald-200 bg-emerald-50 text-emerald-900" },
  uncertain: { label: "Needs a human review", icon: HelpCircle, classes: "border-amber-200 bg-amber-50 text-amber-900" },
} as const;

/**
 * The main demo screen (PRD §14 item 2). Owns the live SSE subscription for
 * one case and renders every panel from the emitted AgentEvents plus the
 * final AnswerFile once the run reaches DONE.
 */
export function CaseDetailView({ caseId }: { caseId: string }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchCaseDetail>> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamDone, setStreamDone] = useState(false);

  const loadDetail = useCallback((id: string) => {
    setDetailError(null);
    fetchCaseDetail(id)
      .then(setDetail)
      .catch((err) => setDetailError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    setEvents([]);
    setStreamError(null);
    setStreamDone(false);
    loadDetail(caseId);
    const unsubscribe = subscribeToCaseEvents(
      caseId,
      (event) =>
        setEvents((prev) =>
          // Dedupe by seq: subscribing replays the backlog, and React
          // StrictMode may mount this effect twice in dev.
          prev.some((e) => e.seq === event.seq) ? prev : [...prev, event],
        ),
      () => {
        setStreamDone(true);
        // Re-fetch detail now that the run is done: the AnswerFile (verdict,
        // SAR, final recommendations) only exists server-side once the run
        // completes, and the initial fetch in loadDetail predates it. Without
        // this the answer panels stay empty until a manual reload.
        loadDetail(caseId);
      },
      (message) => setStreamError(message),
    );
    return unsubscribe;
  }, [caseId, loadDetail]);

  const latestState = events.at(-1)?.state ?? null;
  const running = !streamDone && (events.length > 0 || detail?.session?.status === "running");

  const evidenceItems = useMemo(() => {
    const seen = new Map<string, EvidenceItem>();
    for (const event of events) {
      if (event.type === "evidence_added") {
        const ev = event.payload["evidence"] as EvidenceItem | undefined;
        if (ev) seen.set(ev.id, ev);
      }
    }
    return [...seen.values()];
  }, [events]);

  const assessment = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === "assessment_updated") {
        return event.payload["assessment"] as Assessment;
      }
    }
    return null;
  }, [events]);

  const explanation = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === "explanation") {
        // The live machine nests the graph as payload.explanation; the WS0
        // fixture recordings store a flat payload. Accept both.
        const nested = event.payload["explanation"] as ExplanationPayload | undefined;
        return nested ?? (event.payload as unknown as ExplanationPayload);
      }
    }
    return null;
  }, [events]);

  const answer: AnswerFile | null = detail?.answer ?? null;

  const triggerType =
    (detail?.case_pack_entry?.trigger_type as string | undefined) ??
    ((detail?.adhoc_trigger as { kind?: string } | undefined)?.kind ?? null);

  if (!detail && !detailError) {
    return (
      <div className="space-y-3">
        <div className="skeleton h-5 w-40" />
        <div className="panel space-y-3">
          <div className="skeleton h-5 w-48" />
          <div className="skeleton h-3 w-72" />
          <div className="skeleton h-40 w-full" />
          <div className="grid grid-cols-3 gap-4">
            <div className="skeleton h-32" />
            <div className="skeleton h-32" />
            <div className="skeleton h-32" />
          </div>
        </div>
      </div>
    );
  }

  const banner = answer ? VERDICT_BANNER[answer.case.verdict] ?? null : null;

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-900">
        <ArrowLeft size={15} /> Case queue
      </Link>

      <CaseHeader
        caseId={caseId}
        state={latestState}
        status={detail?.session?.status}
        answer={answer}
        latestRiskLevel={assessment?.risk_level ?? null}
        latestConfidence={assessment?.confidence ?? null}
        openedAt={detail?.case_pack_entry?.opened_at}
        triggerType={triggerType}
        triggerText={detail?.case_pack_entry?.trigger_text}
      />

      {running ? (
        <p className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          <Loader2 size={13} className="animate-spin" />
          The agent is investigating — events stream in live below.
        </p>
      ) : null}

      {streamDone && !answer ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Investigation complete.
        </p>
      ) : null}

      {banner && answer ? (
        <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${banner.classes}`}>
          <banner.icon size={22} />
          <div>
            <p className="text-sm font-semibold">{banner.label}</p>
            <p className="text-xs opacity-80">
              verdict {answer.case.verdict} · pattern {answer.case.pattern} · P(fraud){" "}
              {answer.case.fraud_probability.toFixed(2)} · exposure ${answer.case.exposure_usd.toFixed(2)}
            </p>
          </div>
        </div>
      ) : null}

      {detail?.session?.status === "error" ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          This run failed (the agent errored mid-investigation). Reopening the case retries it.
        </p>
      ) : null}

      {detail?.has_recording === false ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          No run is available for this case yet — there's no recorded fixture and the current run
          source can't investigate it.
        </p>
      ) : null}
      {detailError ? <ErrorState message={detailError} /> : null}
      {streamError ? <ErrorState message={streamError} /> : null}

      {detail ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Timeline events={events} />
            <EvidencePanel evidence={evidenceItems} />
            <NeighborhoodGraph caseId={caseId} events={events} />
          </div>
          <div className="space-y-4">
            <UncertaintyPanel assessment={assessment} whatWouldChange={explanation?.what_would_change_the_decision ?? null} />
            <EvidenceRequestPanel events={events} />
            <ActionsPanel caseId={caseId} events={events} answer={answer} onDecided={() => loadDetail(caseId)} />
            <SimilarCasesPanel
              evidence={evidenceItems}
              similarPriorCases={answer?.case.similar_prior_cases ?? null}
            />
            <ExplanationSarPanel explanation={explanation} sar={answer?.sar ?? null} />
          </div>
        </div>
      ) : null}
    </div>
  );
}