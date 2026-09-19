// Relative imports (not "@hhgoa/contracts") because tests outside a package
// can't resolve pnpm's per-package node_modules (same convention as tests/ws6).
import type { AgentEvent, AnswerFile, Trigger } from "../../contracts/src/index.js";
import type { RunMode } from "../../eval/src/runner.js";
import type { CaseRun } from "../../eval/src/runner.js";

/** Builds a minimal valid AnswerFile for unit tests (field meanings per README). */
export function exampleAnswer(overrides: Partial<AnswerFile> = {}): AnswerFile {
  const base: AnswerFile = {
    case_id: "HHG-017",
    case: {
      status: "closed_fraud",
      verdict: "fraud",
      fraud_probability: 0.86,
      pattern: "card_testing",
      pattern_description: "",
      affected_txn_ids: ["3450629", "3450630"],
      first_suspicious_txn_id: "3450629",
      connected_card_ids: ["C04570-K1"],
      connected_device_profiles: [],
      exposure_usd: 268.43,
      evidence: [
        {
          claim: "Three online authorizations under $3 within 40 minutes, then a larger purchase",
          source: "graph",
          ref: "query:sample_txn_explain",
          entity_ids: ["3450629", "3450630"],
        },
        { claim: "Customer denied the purchases", source: "customer", ref: "evidence_request:1", entity_ids: [] },
      ],
      similar_prior_cases: ["CC-0141"],
      summary: "Textbook card testing: small online authorizations followed by a larger purchase.",
      written_to_graph: true,
      graph_case_id: "CASE-2016-1187",
    },
    evidence_requests: [
      { type: "customer_validation", asked_after_step: 4, assumed_response: "Customer states they did not make these purchases" },
    ],
    next_best_actions: {
      initial: [
        { action: "VERIFY_WITH_CUSTOMER", route: "auto", reason: "R1: confirm before blocking" },
        { action: "DECLINE_TRANSACTION", route: "L1", reason: "R5: testing sequence observed" },
      ],
      final: [
        { action: "BLOCK_CARD", route: "L1", reason: "R2 and R5: customer denied; exposure under $2,500" },
        { action: "FILE_REPORT", route: "L2", reason: "R2: shared device link" },
      ],
      what_changed: "Customer denial raised probability and confirmed the block.",
    },
    sar: {
      file: true,
      reason: "R2: confirmed unauthorized use linked by a shared device",
      narrative:
        "On 2016-11-12 card C04570-K1 was used for three online authorizations followed by a 259.98 online purchase. The cardholder stated they did not make these purchases. Sequence of small authorizations followed by a larger purchase is consistent with card testing.",
      subjects: ["C04570", "C04570-K1"],
      total_amount_usd: 268.43,
      activity_dates: ["2016-11-12", "2016-11-12"],
    },
    stop_reason: "Customer denial settled the verdict; device link identified.",
    tool_calls: 9,
    tokens: 12480,
    latency_s: 18.7,
  };
  return { ...base, ...overrides };
}

const mode: RunMode = { toolsBackend: "fake", llmBackend: "mock", model: "mock" };

/** Builds a canned CaseRun around an answer (export/metrics tests). */
export function caseRun(caseId: string, answer: AnswerFile | null, extra: Partial<CaseRun> = {}): CaseRun {
  return {
    case_id: caseId,
    mode,
    answer,
    events: [] as AgentEvent[],
    toolCalls: extra.toolCalls ?? answer?.tool_calls ?? 0,
    tokens: extra.tokens ?? answer?.tokens ?? 0,
    latencyMs: extra.latencyMs ?? (answer?.latency_s ?? 0) * 1000,
    error: extra.error ?? null,
    fromCache: extra.fromCache ?? false,
    ranAt: "2026-09-19T00:00:00Z",
  };
}

export const riskTrigger: Trigger = { kind: "risk_score", txn_id: "3450629", card_id: "C04570-K1", risk_score: 0.57 };
export const customerTrigger: Trigger = { kind: "customer_report", customer_id: "C08623", txn_ids: ["3530164"], text: "Customer C08623 message: 'I never made this $49.00 purchase.'" };