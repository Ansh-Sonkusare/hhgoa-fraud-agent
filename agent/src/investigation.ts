import type {
  BaselineDeviationData,
  CommunityData,
  EntityProfileData,
  EvidenceEntityRef,
  EvidenceItem,
  FindPriorCasesData,
  LookupExternalData,
  NeighborhoodData,
  PatternDetection,
  PriorCaseRef,
  ResolveTriggerData,
  SharedEntityRing,
  SimilarCaseRef,
  TransactionHistoryRow,
  Trigger,
  VelocityData,
  ToolCatalog,
} from "@hhgoa/contracts";
import { buildEvidenceForTool, createEvidenceIdGen, type EvidenceIdGen } from "./evidenceBuilder.js";

/**
 * The run-local investigation state the machine accumulates as tools are
 * called. Keep tool-agnostic *semantic* facts here (typed) rather than raw
 * envelopes — this is what the assessor, planner, recommender, explainer,
 * policy case-state and SAR facts all read from. `evidence` is a separate
 * per-item store the machine owns (see machine.ts).
 */
export interface InvestigationFacts {
  case_id: string;
  as_of: string;
  trigger: Trigger;
  risk_score: number | null;
  resolved: ResolveTriggerData | null;
  primary_card: EvidenceEntityRef | null;
  customer: EvidenceEntityRef | null;
  identity: EvidenceEntityRef | null;
  txn: EvidenceEntityRef | null;
  txn_rows: TransactionHistoryRow[];
  affected_txn_ids: string[];
  exposure_usd: number;
  velocity: VelocityData | null;
  baseline: BaselineDeviationData | null;
  rings: SharedEntityRing[];
  connected_card_ids: string[];
  device_profiles: string[];
  patterns: PatternDetection[];
  community: CommunityData | null;
  neighborhood: NeighborhoodData | null;
  profile: EntityProfileData | null;
  prior_cases: PriorCaseRef[];
  similar_cases: SimilarCaseRef[];
  external: LookupExternalData | null;
  customer_denied: boolean;
  customer_confirmed: boolean;
}

export function createFacts(case_id: string, as_of: string, trigger: Trigger): InvestigationFacts {
  return {
    case_id,
    as_of,
    trigger,
    risk_score: trigger.kind === "risk_score" ? trigger.risk_score : null,
    resolved: null,
    primary_card: null,
    customer: null,
    identity: null,
    txn: null,
    txn_rows: [],
    affected_txn_ids: [],
    exposure_usd: 0,
    velocity: null,
    baseline: null,
    rings: [],
    connected_card_ids: [],
    device_profiles: [],
    patterns: [],
    community: null,
    neighborhood: null,
    profile: null,
    prior_cases: [],
    similar_cases: [],
    external: null,
    customer_denied: false,
    customer_confirmed: false,
  };
}

/**
 * The standard, deterministic first-pass investigation plan (PRD §9.4).
 * Mirrors the recorded answer fixtures (fixtures/case-run-*.json): a
 * COMPACT sweep that reaches three independent evidence categories fast —
 * transaction behavior, device identity, prior cases — plus a conditional
 * baseline-deviation check when exactly one transaction is affected (the
 * "single suspicious purchase" shape). Tools run in a fixed order so
 * evidence ids stay stable across runs; each tool call goes through the
 * registry, so `tool_call`/`tool_result` events and the tool budget are
 * updated exactly like the recorded runs.
 *
 * The other graph tools (velocity, patterns, community, neighborhood,
 * similar cases, profile, external) stay available as exported gather steps
 * for manual/diagnostic use but are NOT part of the standard sweep — the
 * recorded agents never needed them to reach a decision.
 */
export const COMPACT_GATHER_STEPS = [
  "resolve_trigger",
  "get_transaction_history",
  "find_shared_entity_rings",
  "find_prior_cases",
] as const;

const CARD_TESTING_SMALL_NOISE = 5;

export interface GatherRuntime {
  catalog: ToolCatalog;
  facts: InvestigationFacts;
  idGen: EvidenceIdGen;
  asOf: string;
  onEvidence(item: EvidenceItem): Promise<void>;
}

async function resolveTrigger(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  const res = await g.catalog.resolve_trigger(f.trigger, g.asOf);
  const data = res.ok ? (res.data as ResolveTriggerData) : null;
  f.resolved = data;
  if (data) {
    f.txn = data.txn ?? null;
    f.primary_card = data.card ?? null;
    f.customer = data.customer ?? null;
    f.identity = data.identity ?? null;
  }
  await emitEvidence(g, "resolve_trigger", data);
}

async function txnHistory(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  const res = await g.catalog.get_transaction_history(
    f.primary_card,
    { hours: 2 },
    g.asOf,
  );
  if (!res.ok) return;
  const data = res.data as {
    rows: TransactionHistoryRow[];
    stats?: { total_amount_usd?: number };
  };
  f.txn_rows = data.rows ?? [];
  const affected = (data.rows ?? []).filter(
    (r) =>
      r.risk_score >= 0.3 ||
      r.amount_usd >= 100 ||
      (r.amount_usd < CARD_TESTING_SMALL_NOISE && r.channel === "online"),
  );
  f.affected_txn_ids = affected.map((r) => r.txn_id);
  f.exposure_usd = affected.reduce((s, r) => s + r.amount_usd, 0);
  await emitEvidence(g, "get_transaction_history", data);
}

async function baseline(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.txn || f.affected_txn_ids.length !== 1) return;
  const res = await g.catalog.get_baseline_deviation(f.txn, g.asOf);
  if (!res.ok) return;
  f.baseline = res.data as BaselineDeviationData;
  await emitEvidence(g, "get_baseline_deviation", f.baseline);
}

async function rings(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  const res = await g.catalog.find_shared_entity_rings(f.primary_card, g.asOf);
  if (!res.ok) return;
  const data = res.data as { rings: SharedEntityRing[] };
  f.rings = data.rings ?? [];
  const primary = f.primary_card.id;
  f.connected_card_ids = [
    ...new Set(f.rings.flatMap((r) => r.card_ids).filter((c) => c !== primary)),
  ];
  f.device_profiles = [
    ...new Set(f.rings.filter((r) => r.shared_type === "device").map((r) => r.shared_id)),
  ];
  await emitEvidence(g, "find_shared_entity_rings", data);
}

async function priorCases(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  const res = await g.catalog.find_prior_cases(f.primary_card, g.asOf);
  if (!res.ok) return;
  f.prior_cases = (res.data as FindPriorCasesData).cases ?? [];
  await emitEvidence(g, "find_prior_cases", res.data);
}

async function emitEvidence(g: GatherRuntime, tool: string, data: unknown): Promise<void> {
  const items = buildEvidenceForTool(tool, data, g.idGen, g.asOf);
  for (const it of items) {
    await g.onEvidence(it);
  }
}

/**
 * Run the standard compact first pass. Safe to run more than once with the
 * same `facts`/`idGen` — evidence ids continue from where they left off, so
 * re-entering INVESTIGATING would only ever add NEW items (dedupe lives in
 * the machine's `onEvidence`).
 */
export async function runStandardGather(g: GatherRuntime): Promise<void> {
  await resolveTrigger(g);
  await txnHistory(g);
  await baseline(g);
  await rings(g);
  await priorCases(g);
}

export {
  createEvidenceIdGen,
};

export type { EvidenceIdGen };

/** Convenience: fresh gather runtime for a new case (test/CLI helper). */
export function createGatherRuntime(
  deps: Pick<GatherRuntime, "catalog" | "asOf"> & {
    facts: InvestigationFacts;
  },
): GatherRuntime {
  return {
    catalog: deps.catalog,
    facts: deps.facts,
    idGen: createEvidenceIdGen(),
    asOf: deps.asOf,
    onEvidence: () => Promise.resolve(),
  };
}