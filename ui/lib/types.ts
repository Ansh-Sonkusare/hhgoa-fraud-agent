// Re-exported from the frozen contracts package (PRD §8) — the UI never
// invents its own shape for these; it renders exactly what the API/agent
// produce.
export type {
  AgentEvent,
  AgentState,
  AnswerFile,
  CaseRecord,
  Assessment,
  Hypothesis,
  EvidenceItem,
  Sar,
  NextBestAction,
} from "@hhgoa/contracts";

import type { AnswerFile as AnswerFileT } from "@hhgoa/contracts";

export type TriggerType = "risk_score" | "customer_report" | "analyst_request";

/** One row of GET /api/cases (api/src/server.ts). */
export interface CaseListItem {
  case_id: string;
  opened_at: string;
  trigger_type: TriggerType | string;
  trigger_text: string;
  flagged_txn_id: string;
  card_id: string;
  customer_id: string;
  risk_score: number | null;
  source: "case_pack" | "fixture_demo" | "adhoc";
  has_recording: boolean;
  status: "idle" | "running" | "done" | "error" | "no_recording";
  verdict: AnswerFileT["case"]["verdict"] | null;
  fraud_probability: number | null;
}

export interface PendingApproval {
  seq: number;
  case_id: string;
  action: string;
  route: string;
  reason: string;
  ts: string;
}

/** GET /api/cases/:caseId (api/src/server.ts). */
export interface CaseDetail {
  case_id: string;
  case_pack_entry: {
    case_id: string;
    opened_at: string;
    trigger_type: TriggerType;
    flagged_txn_id: string;
    card_id: string;
    customer_id: string;
    risk_score: number | null;
    trigger_text: string;
  } | null;
  adhoc_trigger: unknown;
  has_recording: boolean;
  session: {
    status: "idle" | "running" | "done" | "error";
    emitted_event_count: number;
    total_event_count: number | null;
    pending_approvals: PendingApproval[];
  } | null;
  answer: AnswerFileT | null;
}
