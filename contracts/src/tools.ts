import type { ToolResult } from "./toolEnvelope.js";
import type { EvidenceEntityRef, EvidenceItem } from "./evidenceItem.js";
import type { Assessment } from "./assessment.js";
import type { CaseStatus, NextBestAction, Sar } from "./answerFile.js";
import type {
  PolicyCheckInput,
  PolicyCheckResult,
  ExecuteActionInput,
  ExecuteActionResult,
  EvidenceRequestInput,
  EvidenceResponse,
} from "./policy.js";

/**
 * Tool catalog (PRD §8.4) — signatures only, no implementations. Every
 * graph/RAG/memory tool takes `as_of` per PRD §8.1; `get_wide_features`
 * (local DuckDB) and `lookup_external` (external enrichment) do not, per
 * the catalog's own wording. `contracts/src/fakes.ts` implements this
 * exact catalog against `contracts/examples/*.json`.
 */

export type EntityRef = EvidenceEntityRef;

export interface RiskSignalTrigger {
  kind: "risk_score";
  txn_id?: string;
  card_id?: string;
  risk_score: number;
}
export interface CustomerReportTrigger {
  kind: "customer_report";
  customer_id: string;
  txn_ids?: string[];
  text: string;
}
export interface AnalystRequestTrigger {
  kind: "analyst_request";
  entity: EntityRef;
  question: string;
}
export type Trigger =
  | RiskSignalTrigger
  | CustomerReportTrigger
  | AnalystRequestTrigger;

// --- Graph tools (executed via MCP -> installed GSQL queries) ---

export interface ResolveTriggerData {
  txn?: EntityRef;
  card?: EntityRef;
  customer?: EntityRef;
  identity?: EntityRef;
}
export type ResolveTrigger = (
  trigger: Trigger,
  as_of: string,
) => Promise<ToolResult<ResolveTriggerData>>;

export interface EntityProfileData {
  entity: EntityRef;
  attributes: Record<string, unknown>;
}
export type GetEntityProfile = (
  entity: EntityRef,
  as_of: string,
) => Promise<ToolResult<EntityProfileData>>;

export interface TransactionHistoryRow {
  txn_id: string;
  ts: string;
  amount_usd: number;
  product_cd: string;
  channel: "in_person" | "online";
  risk_score: number;
}
export interface TransactionHistoryData {
  rows: TransactionHistoryRow[];
  stats: { count: number; total_amount_usd: number; window: string };
}
export type GetTransactionHistory = (
  entity: EntityRef,
  window: { hours?: number; days?: number },
  as_of: string,
) => Promise<ToolResult<TransactionHistoryData>>;

export interface NeighborhoodNode {
  type: string;
  id: string;
}
export interface NeighborhoodEdge {
  type: string;
  from: string;
  to: string;
}
export interface NeighborhoodData {
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
}
export type GetNeighborhood = (
  entity: EntityRef,
  hops: 1 | 2 | 3,
  filters: Record<string, unknown>,
  as_of: string,
) => Promise<ToolResult<NeighborhoodData>>;

export interface VelocityData {
  count: number;
  window_minutes: number;
  total_amount_usd: number;
}
export type ComputeVelocity = (
  entity: EntityRef,
  window_minutes: number,
  as_of: string,
) => Promise<ToolResult<VelocityData>>;

export interface SharedEntityRing {
  shared_type: "device" | "email" | "address";
  shared_id: string;
  card_ids: string[];
  community_id?: string;
}
export interface SharedEntityRingsData {
  rings: SharedEntityRing[];
}
export type FindSharedEntityRings = (
  entity: EntityRef,
  as_of: string,
) => Promise<ToolResult<SharedEntityRingsData>>;

export interface BaselineDeviationData {
  amount_z: number;
  geo_z: number;
  device_z: number;
  time_z: number;
}
export type GetBaselineDeviation = (
  txn: EntityRef,
  as_of: string,
) => Promise<ToolResult<BaselineDeviationData>>;

export interface PatternDetection {
  pattern_id: string;
  score: number;
  evidence: string[];
}
export interface DetectPatternsData {
  patterns: PatternDetection[];
}
export type DetectPatterns = (
  entity_or_txn: EntityRef,
  as_of: string,
) => Promise<ToolResult<DetectPatternsData>>;

export interface CommunityData {
  community_id: string;
  size: number;
  stats: Record<string, number>;
}
export type GetCommunity = (
  entity: EntityRef,
  as_of: string,
) => Promise<ToolResult<CommunityData>>;

export interface PriorCaseRef {
  case_id: string;
  outcome: "confirmed_fraud" | "cleared";
  pattern: string;
}
export interface FindPriorCasesData {
  cases: PriorCaseRef[];
}
export type FindPriorCases = (
  entity: EntityRef,
  as_of: string,
) => Promise<ToolResult<FindPriorCasesData>>;

export interface WideFeaturesRow {
  txn_id: string;
  features: Record<string, number | string | null>;
}
export interface GetWideFeaturesData {
  rows: WideFeaturesRow[];
}
export type GetWideFeatures = (
  txn_ids: string[],
) => Promise<ToolResult<GetWideFeaturesData>>;

// --- RAG / memory tools ---

export interface PolicyChunkRef {
  chunk_id: string;
  text: string;
  source_doc: string;
  pattern_id?: string;
}
export interface RetrievePolicyData {
  chunks: PolicyChunkRef[];
  required_evidence: string[];
  permitted_actions: string[];
}
export type RetrievePolicy = (
  query: string,
  pattern_id: string | undefined,
  k: number,
) => Promise<ToolResult<RetrievePolicyData>>;

export interface SimilarCaseRef {
  case_id: string;
  score: number;
  outcome: "confirmed_fraud" | "cleared";
  overlap_reason: string;
}
export interface RetrieveSimilarCasesData {
  cases: SimilarCaseRef[];
}
export type RetrieveSimilarCases = (
  fingerprint: Record<string, unknown>,
  as_of: string,
  k: number,
) => Promise<ToolResult<RetrieveSimilarCasesData>>;

export interface LookupExternalData {
  kind: "email_domain" | "ip" | "geo";
  value: string;
  enrichment: Record<string, unknown>;
}
export type LookupExternal = (
  kind: "email_domain" | "ip" | "geo",
  value: string,
) => Promise<ToolResult<LookupExternalData>>;

// --- Case tools ---

export interface CaseOpenData {
  case_id: string;
  graph_case_id: string;
}
export type CaseOpen = (
  trigger: Trigger,
  as_of: string,
) => Promise<ToolResult<CaseOpenData>>;

export interface CaseAckData {
  case_id: string;
  ok: true;
}

export interface Finding {
  id: string;
  category: string;
  text: string;
  score: number;
}
export interface Decision {
  id: string;
  text: string;
  actor: string;
}

export type CaseAddEvidence = (
  case_id: string,
  evidence: EvidenceItem,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;
export type CaseAddFinding = (
  case_id: string,
  finding: Finding,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;
export type CaseUpdateAssessment = (
  case_id: string,
  assessment: Assessment,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;
export type CaseRecordDecision = (
  case_id: string,
  decision: Decision,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;
export type CaseRecordAction = (
  case_id: string,
  action: NextBestAction,
  status: ExecuteActionResult,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;
export type CaseSetStatus = (
  case_id: string,
  status: CaseStatus,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;
export type CaseClose = (
  case_id: string,
  as_of: string,
) => Promise<ToolResult<CaseAckData>>;

// --- Policy / action tools ---

export type PolicyCheck = (
  input: PolicyCheckInput,
) => Promise<ToolResult<PolicyCheckResult>>;
export type ExecuteAction = (
  input: ExecuteActionInput,
) => Promise<ToolResult<{ result: ExecuteActionResult }>>;
export type RequestEvidence = (
  input: EvidenceRequestInput,
) => Promise<ToolResult<EvidenceResponse>>;
export type GenerateSar = (case_id: string) => Promise<ToolResult<Sar>>;

/** The full tool catalog keyed by tool name (PRD §8.4). */
export interface ToolCatalog {
  resolve_trigger: ResolveTrigger;
  get_entity_profile: GetEntityProfile;
  get_transaction_history: GetTransactionHistory;
  get_neighborhood: GetNeighborhood;
  compute_velocity: ComputeVelocity;
  find_shared_entity_rings: FindSharedEntityRings;
  get_baseline_deviation: GetBaselineDeviation;
  detect_patterns: DetectPatterns;
  get_community: GetCommunity;
  find_prior_cases: FindPriorCases;
  get_wide_features: GetWideFeatures;
  retrieve_policy: RetrievePolicy;
  retrieve_similar_cases: RetrieveSimilarCases;
  lookup_external: LookupExternal;
  case_open: CaseOpen;
  case_add_evidence: CaseAddEvidence;
  case_add_finding: CaseAddFinding;
  case_update_assessment: CaseUpdateAssessment;
  case_record_decision: CaseRecordDecision;
  case_record_action: CaseRecordAction;
  case_set_status: CaseSetStatus;
  case_close: CaseClose;
  policy_check: PolicyCheck;
  execute_action: ExecuteAction;
  request_evidence: RequestEvidence;
  generate_sar: GenerateSar;
}

export type ToolName = keyof ToolCatalog;
