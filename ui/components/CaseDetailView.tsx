"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * The main demo screen (PRD §14 item 2). Owns the live SSE subscription for
 * one case and renders every panel from the emitted AgentEvents plus the
 * final AnswerFile once the replay reaches DONE.
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
      () => setStreamDone(true),
      (message) => setStreamError(message),
    );
    return unsubscribe;
  }, [caseId, loadDetail]);

  const latestState = events.at(-1)?.state ?? null;

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
        return event.payload as unknown as ExplanationPayload;
      }
    }
    return null;
  }, [events]);

  const answer: AnswerFile | null = detail?.answer ?? null;

  const triggerType =
    (detail?.case_pack_entry?.trigger_type as string | undefined) ??
    ((detail?.adhoc_trigger as { kind?: string } | undefined)?.kind ?? null);

  if (!detail && !detailError) {
    return <p className="text-sm text-slate-500">Loading case {caseId}…</p>;
  }

  return (
    <div className="space-y-4">
      <CaseHeader
        caseId={caseId}
        state={latestState}
        answer={answer}
        latestRiskLevel={assessment?.risk_level ?? null}
        latestConfidence={assessment?.confidence ?? null}
        openedAt={detail?.case_pack_entry?.opened_at}
        triggerType={triggerType}
        triggerText={detail?.case_pack_entry?.trigger_text}
      />

      {streamDone ? (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Investigation replay complete.
        </p>
      ) : null}
      {detail?.has_recording === false ? (
        <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          No recorded run for this case yet — WS4's live agent isn't merged, so it can&apos;t be
          replayed. A live agent run will stream in on this same page with no API change.
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