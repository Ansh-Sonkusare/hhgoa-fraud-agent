/**
 * WS3-internal types. These are NOT `contracts/` — contracts is frozen and
 * doesn't define a shape for `context_bundle` or the on-disk index records
 * (PRD §11 names `context_builder`/`ContextBundle` but never gives it a
 * schema; it's an internal rag<->agent handoff, not a graded tool
 * signature). Where a shape below overlaps a contract type
 * (`PolicyChunkRef`, `SimilarCaseRef`, evidence categories), the contract
 * type is reused/composed here rather than re-declared, so tool output
 * stays byte-identical to `contracts/src/tools.ts`.
 */
import type { EvidenceCategory, PolicyActionName } from "@hhgoa/contracts";

export type SourceDocKind = "policy" | "pattern" | "regulatory";

/** A chunk of policy/pattern/regulatory text, embedded and stored. */
export interface PolicyChunkRecord {
  chunk_id: string;
  text: string;
  source_doc: string;
  source_kind: SourceDocKind;
  heading_path: string;
  /** Pattern this chunk primarily describes, if any (`DESCRIBES` edge, PRD §7). */
  pattern_id?: string;
  embedding: number[];
  token_count: number;
}

/** A documented (or discovered) fraud pattern node, with its local links. */
export interface PatternRecord {
  pattern_id: string;
  name: string;
  kind: "documented" | "discovered";
  /** `Pattern -REQUIRES_EVIDENCE-> EvidenceType` (PRD §7), evidence-type ids. */
  required_evidence: string[];
  /** Policy action identifiers permitted for this pattern per the policy rules. */
  permitted_actions: PolicyActionName[];
  /** Which policy rule(s) this mapping is grounded in, for provenance. */
  rule_refs: string[];
}

export type AmountBand =
  | "under_100"
  | "100_to_500"
  | "500_to_1000"
  | "1000_to_5000"
  | "over_5000";

export function amountBand(usd: number): AmountBand {
  const a = Math.abs(usd);
  if (a < 100) return "under_100";
  if (a < 500) return "100_to_500";
  if (a < 1000) return "500_to_1000";
  if (a < 5000) return "1000_to_5000";
  return "over_5000";
}

/** PRD §11 fingerprint: "{pattern, key entity ids/types, amounts band, device/address signals, outcome}". */
export interface CaseFingerprint {
  pattern: string;
  entity_ids: { type: string; id: string }[];
  amount_band: AmountBand;
  device_signals: string[];
  address_signals: string[];
  outcome: "confirmed_fraud" | "cleared" | "unresolved";
}

/** A case memory record — either loaded from `closed_cases_history.csv`, or
 * written back by the agent at MEMORY_UPDATE (`memory.ts`). */
export interface CaseMemoryRecord {
  case_id: string;
  source: "closed_case_history" | "agent_written";
  customer_id: string;
  card_id: string;
  connected_card_ids: string[];
  pattern: string;
  outcome: "confirmed_fraud" | "cleared" | "unresolved";
  exposure_usd: number;
  opened_at: string;
  closed_at: string | null;
  /** as_of visibility: when this record became knowable to later
   * investigations. For historical cases this is `closed_at` (the outcome
   * isn't known/citable until the case closed); for agent-written cases
   * it's the MEMORY_UPDATE timestamp. */
  visible_from: string;
  summary_text: string;
  analyst_notes: string;
  fingerprint: CaseFingerprint;
  embedding: number[];
}

export interface ContextBundleItem {
  id: string;
  kind: "policy_chunk" | "prior_case" | "evidence" | "pattern";
  text: string;
  source_doc: string;
  token_count: number;
  score: number;
}

/** PRD §11/R4: curated, provenance-tagged, <= 6k tokens. This is what the
 * LLM actually sees — never raw row dumps. */
export interface ContextBundle {
  items: ContextBundleItem[];
  total_tokens: number;
  budget_tokens: number;
  truncated: boolean;
  provenance_ids: string[];
}

export type { EvidenceCategory };
