import { amountBand } from "@hhgoa/rag";
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
  DetectPatternsData,
  RetrieveSimilarCasesData,
  ToolCatalog,
} from "@hhgoa/contracts";
import {
  buildEvidenceForTool,
  computeBaselineHome,
  createEvidenceIdGen,
  readProxyDeviceRing,
  type BaselineHome,
  type EvidenceIdGen,
  type ProxyDeviceRing,
} from "./evidenceBuilder.js";
import { assessSharedOrigin, MAX_CORROBORATING_RING_SIZE } from "./sharedOrigin.js";
import { EPISODE_LOOKBACK_HOURS, EPISODE_MIN_SCORE, TINY_ONLINE_USD, episodeScore, priorRegions, type EpisodeRow } from "./episodeModel.js";

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
  /** The flagged charge's own time, read from its profile when the history window did not reach it. */
  txn_ts?: string;
  txn_rows: TransactionHistoryRow[];
  /** Charges in the narrow burst around the flagged one; 1 means it stood alone (gates the baseline check). */
  burst_txn_count: number;
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
  /**
   * R7: the cardholder disputed a charge that repeats their own monthly
   * pattern. Set only by the dispute step; when true, `customer_denied` is not.
   */
  dispute_recurring: boolean;
  /**
   * The undocumented cross-card device ring, when the flagged charge's device
   * is one (evidenceBuilder.readProxyDeviceRing). A graph finding: it names the
   * pattern `undocumented` and triggers R9; null when the device is ordinary.
   */
  proxy_device_ring: ProxyDeviceRing | null;
  /**
   * The agent asked the cardholder to verify (customer validation or step-up)
   * and no reply came back. The dataset supplies none (README §5), so this is
   * the honest state after asking; R4 ("no reply") then governs the final
   * recommendation. Nothing about the reply's content is assumed.
   */
  verification_unanswered: boolean;
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
    burst_txn_count: 0,
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
    dispute_recurring: false,
    proxy_device_ring: null,
    verification_unanswered: false,
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
/**
 * How far back the transaction sweep reaches. A case is opened hours after
 * the transaction that prompted it — 1-6h across all three trigger kinds in
 * this case pack, not just for a cardholder who reports a charge late — so a
 * short lookback from `opened_at` misses the flagged transaction itself on
 * 16 of the 20 cases and the case lands with no episode and zero exposure.
 * Fetching wide is safe because `affected` is narrowed back to the episode
 * around the flagged transaction below (scopeEpisode).
 *
 * 7 days rather than 3: measured over the 4,665 confirmed-fraud closed cases,
 * the oldest fraud transaction is a median 22h old at `opened_at` but p95 is
 * 109h, so a 72h sweep sees every fraud transaction in only 89.8% of cases
 * against 97.8% at 168h. Cases are opened after the episode has already run,
 * not during it.
 */
const LOOKBACK_HOURS = 168;
/**
 * Days of history before the investigation window used to find the card's usual
 * card-present region (90 days back from as_of, minus the 7-day window).
 */
const BASELINE_HOME_DAYS = 83;
/** How far either side of the flagged charge still counts as one episode. */
const EPISODE_HOURS = 2;
/** Velocity window: one day, long enough to catch a burst without spanning the episode. */
const VELOCITY_WINDOW_MINUTES = 1440;
/** How many similar prior cases to retrieve from case memory. */
const SIMILAR_CASES_K = 5;

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

interface FlaggedChargeProfile {
  ts: string | null;
  amount_usd: number;
}

/**
 * The flagged charge's time and amount from its own vertex (get_entity_profile
 * "txn" branch), for when the history window does not contain it. Cached on
 * the facts so the dispute step does not read it twice.
 */
async function flaggedChargeProfile(g: GatherRuntime, txn: EvidenceEntityRef): Promise<FlaggedChargeProfile | null> {
  const prof = await g.catalog.get_entity_profile(txn, g.asOf);
  if (!prof.ok) return null;
  const attrs = (prof.data as EntityProfileData).attributes ?? {};
  if (String(attrs["entity_id"] ?? txn.id) !== txn.id) return null;
  const ts = typeof attrs["ts"] === "string" && attrs["ts"] !== "" ? (attrs["ts"] as string) : null;
  if (ts) g.facts.txn_ts = ts;
  return { ts, amount_usd: Number(attrs["amount_usd"]) };
}

/** Tool timestamps are "YYYY-MM-DD HH:MM:SS" in UTC (see shiftAsOf). */
function parseToolTs(ts: string): number {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  return Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
}

async function txnHistory(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  let windowHours = LOOKBACK_HOURS;
  let res = await g.catalog.get_transaction_history(f.primary_card, { hours: windowHours }, g.asOf);
  if (!res.ok) return;
  // The window has to contain the charge the case is about. A disputed charge
  // can predate it: backtest CC-2394's cardholder disputed a charge 20 days
  // before the case opened, the fixed 168h window never saw it, and the
  // investigation described the wrong week with no pattern-shape item for the
  // flagged charge at all. When that happens the window is widened back to the
  // charge (never past as_of, never beyond the R7 lookback). A card busy
  // enough to hit the history's row cap can still lose it; that is reported
  // below exactly as before, not papered over.
  let flaggedProfile: FlaggedChargeProfile | null = null;
  const inRows = (r: { ok: boolean; data?: unknown }): boolean =>
    ((r.data as { rows?: TransactionHistoryRow[] } | undefined)?.rows ?? []).some((x) => x.txn_id === f.txn?.id);
  if (f.txn && !inRows(res)) {
    flaggedProfile = await flaggedChargeProfile(g, f.txn);
    const atMs = flaggedProfile?.ts ? parseToolTs(flaggedProfile.ts) : NaN;
    const asOfMs = parseToolTs(g.asOf);
    if (Number.isFinite(atMs) && Number.isFinite(asOfMs) && atMs <= asOfMs) {
      const needed = Math.ceil((asOfMs - atMs) / 3_600_000) + EPISODE_HOURS;
      if (needed > windowHours && needed <= R7_LOOKBACK_DAYS * 24) {
        const wide = await g.catalog.get_transaction_history(f.primary_card, { hours: needed }, g.asOf);
        if (wide.ok) {
          res = wide;
          windowHours = needed;
        }
      }
    }
  }
  const data = res.data as {
    rows: TransactionHistoryRow[];
    stats?: { total_amount_usd?: number };
  };
  const rows = data.rows ?? [];
  f.txn_rows = rows;

  const suspicious = (r: TransactionHistoryRow): boolean =>
    r.risk_score >= 0.3 ||
    r.amount_usd >= 100 ||
    (r.amount_usd < CARD_TESTING_SMALL_NOISE && r.channel === "online");

  // The episode is what sits around the flagged charge, not around the
  // moment the case happened to be opened. Anchoring on the flagged
  // transaction keeps the wide lookback from sweeping in the cardholder's
  // ordinary spending over the hours or days in between.
  const flagged = f.txn ? (rows.find((r) => r.txn_id === f.txn?.id) ?? null) : null;
  // Without a flagged transaction to anchor on there is no way to tell which
  // part of the sweep is the episode, so fall back to the narrow recent
  // window rather than calling three days of ordinary spending "affected".
  const anchorMs = flagged ? Date.parse(flagged.ts) : Date.parse(g.asOf);
  const burst = rows.filter(
    (r) =>
      (flagged !== null && r.txn_id === flagged.txn_id) ||
      (suspicious(r) && Math.abs(Date.parse(r.ts) - anchorMs) <= EPISODE_HOURS * 3_600_000),
  );
  // The burst right around the flagged charge still decides whether the
  // single-charge baseline check applies; the episode below is wider.
  f.burst_txn_count = burst.length;

  const affected = flagged ? scopeEpisode(rows, flagged, "default") : burst;
  setEpisode(f, affected);

  // The flagged charge can fall outside the sweep entirely -- an episode that
  // ran days before the case was opened, or a disputed charge older than the
  // window. machine.ts adds its id back so the reported episode is not missing
  // the transaction the case exists for, but its amount was never added here,
  // so the answer filed affected_txn_ids with a matching exposure of 0. That
  // breaks the README's definition of exposure_usd ("sum of absolute amounts of
  // affected_txn_ids") and silently suppresses two policy rules that key on the
  // figure: R8 escalates an uncertain case over $500, and R2 files a report
  // over $1,000. CC-1275 filed one affected transaction at $0 exposure.
  if (f.txn && !rows.some((r) => r.txn_id === f.txn?.id)) {
    flaggedProfile ??= await flaggedChargeProfile(g, f.txn);
    const amt = flaggedProfile?.amount_usd ?? NaN;
    if (Number.isFinite(amt)) f.exposure_usd += Math.abs(amt);
  }
  // The card's usual region has to be read from BEFORE the window: the window
  // is where the episode happens, and a fraud burst in another region takes
  // it over (see discriminatingEvidence). Asking for the history as of the
  // window's start keeps this strictly earlier than as_of.
  let baselineHome: BaselineHome | undefined;
  const pre = await g.catalog.get_transaction_history(
    f.primary_card,
    { days: BASELINE_HOME_DAYS },
    shiftAsOf(g.asOf, windowHours),
  );
  if (pre.ok) {
    const preRows = ((pre.data as { rows?: TransactionHistoryRow[] }).rows ?? []) as Array<
      TransactionHistoryRow & { addr1?: string }
    >;
    baselineHome = computeBaselineHome(preRows, BASELINE_HOME_DAYS);
  }
  await emitEvidence(g, "get_transaction_history", { ...data, baseline_home: baselineHome });
}

/**
 * `as_of` moved back by `hours`, in the same "YYYY-MM-DD HH:MM:SS" form the
 * tools take. Parsed and printed as UTC explicitly: V8 reads that form as
 * local time, which would shift the window by the machine's offset.
 */
export function shiftAsOf(asOf: string, hours: number): string {
  const iso = asOf.includes("T") ? asOf : asOf.replace(" ", "T");
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(zoned) - hours * 3_600_000;
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Which transactions belong to the fraud episode. The default scope keeps the
 * flagged charge and every row from two hours before it that the episode model
 * scores as belonging (episodeModel.ts, which records how it was measured),
 * plus tiny online probes on an online episode: R5's card-testing probes score
 * low but belong to the episode, as in the README's own card-testing example.
 *
 * Undocumented activity is scoped by channel and product code instead: the
 * structuring bursts and the proxy-device ring score low, so a risk-driven
 * scope drops them (0 of 6 held-out undocumented cases within 25%, against 5
 * of 6).
 */
export function scopeEpisode(
  rows: readonly TransactionHistoryRow[],
  flagged: TransactionHistoryRow,
  mode: "default" | "undocumented",
): TransactionHistoryRow[] {
  const fromMs = parseToolTs(flagged.ts) - EPISODE_LOOKBACK_HOURS * 3_600_000;
  const candidate = (r: TransactionHistoryRow) => r.txn_id !== flagged.txn_id && parseToolTs(r.ts) >= fromMs;
  if (mode === "undocumented") {
    return rows.filter(
      (r) =>
        r.txn_id === flagged.txn_id ||
        (candidate(r) && r.channel === flagged.channel && r.product_cd === flagged.product_cd),
    );
  }
  const prior = priorRegions(rows as readonly EpisodeRow[], flagged as EpisodeRow);
  return rows.filter(
    (r) =>
      r.txn_id === flagged.txn_id ||
      (candidate(r) &&
        (episodeScore(r as EpisodeRow, flagged as EpisodeRow, prior) >= EPISODE_MIN_SCORE ||
          (flagged.channel === "online" && r.channel === "online" && r.amount_usd < TINY_ONLINE_USD))),
  );
}

/** Records the episode oldest first, so affected_txn_ids[0] is the first suspicious charge. */
function setEpisode(f: InvestigationFacts, affected: readonly TransactionHistoryRow[]): void {
  const ordered = [...affected].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  f.affected_txn_ids = ordered.map((r) => r.txn_id);
  // README: "Sum of absolute amounts of affected_txn_ids".
  f.exposure_usd = ordered.reduce((s, r) => s + Math.abs(r.amount_usd), 0);
}

/**
 * Re-scopes the episode once the graph has named the activity undocumented
 * (the proxy-device ring or the amount-structuring burst), which is only known
 * after the detectors run.
 */
function rescopeUndocumented(g: GatherRuntime): void {
  const f = g.facts;
  const undocumented = Boolean(f.proxy_device_ring) || f.patterns.some((p) => p.pattern_id === "undocumented");
  const flagged = f.txn ? f.txn_rows.find((r) => r.txn_id === f.txn?.id) : undefined;
  if (!undocumented || !flagged) return;
  setEpisode(f, scopeEpisode(f.txn_rows, flagged, "undocumented"));
}

async function baseline(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.txn || f.burst_txn_count !== 1) return;
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
  // Only cards the dataset itself names are real ids; tuples we could not map
  // to one carry a synthetic "X" id and would score as fabricated if emitted.
  f.connected_card_ids = [
    ...new Set(
      f.rings.flatMap((r) => r.card_ids).filter((c) => c !== primary && c.startsWith("C")),
    ),
  ];
  f.device_profiles = [
    ...new Set(f.rings.filter((r) => r.shared_type === "device").map((r) => r.shared_id)),
  ];
  await emitEvidence(g, "find_shared_entity_rings", data);
}

/**
 * A case is never its own precedent. `find_prior_cases` gates on
 * `opened_at <= as_of` inclusively, and an investigation runs `as_of` the
 * moment its case was opened, so the case under investigation satisfies that
 * bound and comes back in its own result set whenever a record of it already
 * exists in the graph. Two ways that happens, both real:
 *   - backtesting a labelled closed case (`CC-*`), where the returned row
 *     carries the very `outcome`/`pattern` the run is being scored against —
 *     the agent would be reading the answer key;
 *   - re-running a benchmark case after `persistCase` wrote it back as
 *     `GRAPH-<case_id>`, where it cites its own earlier conclusion as
 *     independent corroboration.
 * Dropping both id forms is what keeps prior-case evidence genuinely prior.
 */
function withoutSelf(cases: PriorCaseRef[], caseId: string): PriorCaseRef[] {
  const self = new Set([caseId, `GRAPH-${caseId}`]);
  return cases.filter((c) => !self.has(c.case_id));
}

async function priorCases(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  const res = await g.catalog.find_prior_cases(f.primary_card, g.asOf);
  if (!res.ok) return;
  const data = res.data as FindPriorCasesData;
  const cases = withoutSelf(data.cases ?? [], f.case_id);
  f.prior_cases = cases;
  await emitEvidence(g, "find_prior_cases", { ...data, cases });
}

/**
 * Second-opinion step after the compact sweep. NOT part of
 * `COMPACT_GATHER_STEPS` (the recorded fixtures never made it) and not a call
 * every case should pay for: `community_lookup` is a whole-graph computation
 * (~5-12s, docs/decisions.md).
 *
 * A plausible shared-element ring alone does not prove a common actor — a
 * coarse device fingerprint or a popular billing region collides often. When
 * the ring is not already corroborated by prior confirmed fraud, ask the graph
 * for the seed card's community; its confirmed-fraud concentration is the
 * policy's "another customer's fraud" test (§3a/R6). Then narrow the derived
 * connected-card/device lists to corroborated rings only, so the answer file
 * cannot report a 500-card fingerprint crowd as a compromise.
 */
export async function runSharedOriginCorroboration(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (f.primary_card && !f.community) {
    const pre = assessSharedOrigin(f);
    const needsCommunity =
      pre.signals.plausible_ring &&
      !pre.signals.prior_confirmed_fraud &&
      !pre.signals.community_confirmed;
    if (needsCommunity) {
      const res = await g.catalog.get_community(f.primary_card, g.asOf);
      if (res.ok) {
        f.community = res.data as CommunityData;
        await emitEvidence(g, "get_community", res.data);
      }
    }
  }
  const a = assessSharedOrigin(f);
  f.connected_card_ids = a.connected_card_ids;
  f.device_profiles = a.device_profiles;
}

async function emitEvidence(g: GatherRuntime, tool: string, data: unknown): Promise<void> {
  const flaggedRow = g.facts.txn ? g.facts.txn_rows.find((r) => r.txn_id === g.facts.txn?.id) : undefined;
  const items = buildEvidenceForTool(
    tool,
    data,
    g.idGen,
    g.asOf,
    g.facts.primary_card?.id,
    g.facts.txn?.id,
    flaggedRow?.channel,
  );
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
/**
 * The GSQL pattern detectors (gsql/queries/detect_patterns.gsql). These score
 * the five documented patterns directly from the graph, which is the one source
 * that names a pattern rather than leaving the model to infer it from prose
 * evidence -- CHALLENGE_BRIEF "Assess the situation by identifying fraud
 * patterns". It was absent from the sweep, so every pattern label came from the
 * assessor reasoning over behavioural claims alone and the detectors never ran.
 */
async function patterns(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  const res = await g.catalog.detect_patterns(f.primary_card, g.asOf);
  if (!res.ok) return;
  const data = res.data as DetectPatternsData;
  f.patterns = data.patterns ?? [];
  await emitEvidence(g, "detect_patterns", data);
}

/** Account behaviour: burst rate over the last day (CHALLENGE_BRIEF "Account behavior"). */
async function velocity(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  const res = await g.catalog.compute_velocity(f.primary_card, VELOCITY_WINDOW_MINUTES, g.asOf);
  if (!res.ok) return;
  f.velocity = res.data as VelocityData;
  await emitEvidence(g, "compute_velocity", f.velocity);
}

/**
 * Case memory retrieval through GraphRAG vector search, as distinct from
 * `find_prior_cases`, which walks the graph for cases on *this* card. This finds
 * cases that look like this one anywhere in the history, which is what
 * CHALLENGE_BRIEF means by "Retrieve similar past cases when investigating new
 * activity" and "Use prior case outcomes ... to inform recommendations".
 */
/**
 * Cards linked to this one through a specific shared device profile or billing
 * region -- the rings ringsEvidence counts toward a web, not the fingerprint
 * crowds it reports as "too large a group to be a specific fraud ring".
 * f.connected_card_ids holds every ring card until corroboration narrows it,
 * so the similar-case query used to match closed cases through crowd members:
 * cleared alert CC-0955, linked specifically to 3 cards, drew five "similar"
 * confirmed-fraud cases each through a different crowd card, and each filed a
 * fraud vote.
 */
function specificRingCards(f: InvestigationFacts): string[] {
  const primary = f.primary_card?.id;
  return [
    ...new Set(
      f.rings
        .filter((r) => r.shared_type !== "email" && r.card_ids.length <= MAX_CORROBORATING_RING_SIZE)
        .flatMap((r) => r.card_ids)
        .filter((c) => c !== primary && c.startsWith("C")),
    ),
  ];
}

async function similarCases(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.primary_card) return;
  // The keys rag's scorer actually reads (CaseFingerprint via
  // coerceFingerprint). This used to send card_id/patterns/channels/
  // exposure_usd, none of which the scorer knows: every query coerced to an
  // empty fingerprint with the default "under_100" band, every stored case
  // scored the same 0.03, and the stable sort handed back the five oldest
  // case ids as "similar" on every investigation.
  //
  // pattern stays "none" on purpose: querying by the detector's own pattern
  // would retrieve precedents because the detector fired and count it twice.
  // device_signals stays empty: the graph's device ids are md5 fingerprints,
  // the stored records hold the raw "DeviceInfo | os | browser | screen"
  // string, so the two never match.
  const flagged = f.txn
    ? (f.txn_rows.find((r) => r.txn_id === f.txn?.id) as (TransactionHistoryRow & { addr1?: string }) | undefined)
    : undefined;
  const fingerprint: Record<string, unknown> = {
    pattern: "none",
    entity_ids: [
      { type: "Card", id: f.primary_card.id },
      ...(f.customer ? [{ type: "Customer", id: f.customer.id }] : []),
      ...specificRingCards(f).map((id) => ({ type: "Card", id })),
    ],
    amount_band: amountBand(f.exposure_usd),
    device_signals: [],
    address_signals: flagged?.addr1 ? [flagged.addr1] : [],
  };
  const res = await g.catalog.retrieve_similar_cases(fingerprint, g.asOf, SIMILAR_CASES_K);
  if (!res.ok) return;
  const data = res.data as RetrieveSimilarCasesData;
  f.similar_cases = data.cases ?? [];
  // A precedent find_prior_cases already cited is one fact, not two: CC-1660
  // (cleared) had its customer's four prior fraud cases counted once as prior
  // cases and again as four similar-case items. They stay in similar_cases
  // (the answer's similar_prior_cases), only the evidence is not repeated.
  const cited = new Set(f.prior_cases.map((c) => c.case_id));
  await emitEvidence(g, "retrieve_similar_cases", {
    ...data,
    cases: f.similar_cases.filter((c) => !cited.has(c.case_id)),
  });
}

/**
 * What the flagged charge's own vertex says that no other step reads: whether
 * its device is the undocumented cross-card ring (R9), and its purchaser email
 * domain for external enrichment (CHALLENGE_BRIEF "External data sources") --
 * the only external handle the dataset exposes. Enrichment is skipped when the
 * charge carries no domain rather than enriching a blank.
 */
async function flaggedTxnProfile(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (!f.txn) return;
  // One profile read of the flagged charge feeds two checks. txn_history does
  // not return the email domain or the device -- TransactionHistoryRow is a
  // frozen 6-field contract type -- so both are read from the transaction
  // vertex. Keying the email lookup off the history row silently never fired.
  const prof = await g.catalog.get_entity_profile(f.txn, g.asOf);
  if (!prof.ok) return;
  const attrs = (prof.data as EntityProfileData).attributes ?? {};

  // The undocumented device ring (R9). Only files evidence when it fires.
  f.proxy_device_ring = readProxyDeviceRing(attrs);
  if (f.proxy_device_ring) await emitEvidence(g, "get_entity_profile", prof.data);

  // External enrichment (CHALLENGE_BRIEF "External data sources").
  const domain = String(attrs["p_email_domain"] ?? "").trim();
  if (!domain) return;
  const res = await g.catalog.lookup_external("email_domain", domain);
  if (!res.ok) return;
  f.external = res.data as LookupExternalData;
  await emitEvidence(g, "lookup_external", f.external);
}

/**
 * R7 ("Disputed but legitimate"): a disputed charge that repeats the
 * cardholder's own monthly pattern -- same merchant, same amount -- is a
 * forgotten subscription, not fraud, and must not be blocked. The dataset has
 * no merchant field, so the product code stands in for it and the exact amount
 * carries most of the weight. Two earlier monthly steps are required: measured
 * on the 4,665 historical disputes (every one confirmed fraud), one step fires
 * on 234 of them (5.0%) and two on 62 (1.3%). None of the 8 benchmark disputes
 * match; HHG-018's 13 identical $39.08 charges land 1-20 days apart on a card
 * with 7,079 transactions, which is a common price, not a subscription.
 */
const R7_LOOKBACK_DAYS = 120;
const R7_MONTH_MIN_DAYS = 26;
const R7_MONTH_MAX_DAYS = 35;
const R7_MIN_PRIOR_MONTHS = 2;
/** txn_history keeps only the 500 most recent rows (txn_history.gsql HeapAccum). */
const TXN_HISTORY_ROW_CAP = 500;

export type RecurringCheck =
  | { status: "recurring"; months: number; matches: number }
  | {
      status: "not_recurring";
      matches: number;
      /** Set when only the monthly windows were read (busy card): the step whose window had no repeat. */
      windowStep?: number;
    }
  | { status: "unchecked"; reason: string };

type HistoryRowWithProduct = Pick<TransactionHistoryRow, "txn_id" | "ts" | "amount_usd"> & {
  product_cd?: string;
};

/**
 * Walks back from the disputed charge through earlier charges of the same
 * amount and product code, counting consecutive steps that land a month apart.
 * `capped` says the history hit the row cap, in which case a miss only rules
 * R7 out if the rows still reach back far enough to have seen the pattern.
 */
export function checkRecurringCharge(
  rows: readonly HistoryRowWithProduct[],
  flaggedId: string,
  capped: boolean,
): RecurringCheck {
  const flagged = rows.find((r) => r.txn_id === flaggedId);
  if (!flagged) {
    return {
      status: "unchecked",
      reason: capped
        ? `the card has more transactions in ${R7_LOOKBACK_DAYS} days than the ${TXN_HISTORY_ROW_CAP}-row history returns, and the rows returned do not reach back to the disputed transaction ${flaggedId}`
        : `the disputed transaction ${flaggedId} is not in the card's ${R7_LOOKBACK_DAYS}-day history`,
    };
  }
  if (!flagged.product_cd) {
    return { status: "unchecked", reason: "the history did not return a product code to compare" };
  }
  const at = Date.parse(flagged.ts);
  const same = rows
    .filter(
      (r) =>
        r.txn_id !== flaggedId &&
        Date.parse(r.ts) < at &&
        r.product_cd === flagged.product_cd &&
        Math.abs(r.amount_usd - flagged.amount_usd) < 0.005,
    )
    .map((r) => Date.parse(r.ts))
    .sort((a, b) => b - a);
  let cursor = at;
  let months = 0;
  for (const t of same) {
    const gapDays = (cursor - t) / 86_400_000;
    if (gapDays < R7_MONTH_MIN_DAYS) continue;
    if (gapDays > R7_MONTH_MAX_DAYS) break;
    cursor = t;
    months += 1;
  }
  if (months >= R7_MIN_PRIOR_MONTHS) return { status: "recurring", months, matches: same.length };
  if (capped) {
    const oldest = Math.min(...rows.map((r) => Date.parse(r.ts)));
    const needed = at - R7_MIN_PRIOR_MONTHS * R7_MONTH_MAX_DAYS * 86_400_000;
    if (oldest > needed) {
      const reachedDays = Math.floor((at - oldest) / 86_400_000);
      return {
        status: "unchecked",
        reason: `the card is busy enough that its ${TXN_HISTORY_ROW_CAP}-row history reaches back only ${reachedDays} days, short of the ${R7_MIN_PRIOR_MONTHS * R7_MONTH_MAX_DAYS} needed to see two monthly repeats`,
      };
    }
  }
  return { status: "not_recurring", matches: same.length };
}

const DAY_MS = 86_400_000;
/** A card too busy for one 9-day read is read in 3-day slices. */
const R7_SLICE_HOURS = 72;

/**
 * R7 on a card too busy for the 500-row history: instead of the whole
 * lookback, read only the window each monthly step could land in (26-35 days
 * before the current step), so the row cap never cuts the pattern off. One
 * read per step, or three 3-day slices when a step's window alone passes the
 * cap; the first step with no match rules R7 out. HHG-011 and HHG-018 used to
 * file "R7 could not be checked" because their 500 newest rows reached back
 * only 12-13 days.
 */
async function checkRecurringByMonthlyWindows(
  g: GatherRuntime,
  card: EvidenceEntityRef,
  flagged: HistoryRowWithProduct,
): Promise<RecurringCheck> {
  const stepHours = (R7_MONTH_MAX_DAYS - R7_MONTH_MIN_DAYS) * 24;
  const read = async (endMs: number, hours: number): Promise<HistoryRowWithProduct[] | null> => {
    const res = await g.catalog.get_transaction_history(card, { hours }, shiftAsOf(g.asOf, (parseToolTs(g.asOf) - endMs) / 3_600_000));
    if (!res.ok) return null;
    return (res.data as { rows?: HistoryRowWithProduct[] }).rows ?? [];
  };
  let cursor = parseToolTs(flagged.ts);
  let months = 0;
  let matches = 0;
  for (let step = 0; step < R7_MIN_PRIOR_MONTHS; step++) {
    const end = cursor - R7_MONTH_MIN_DAYS * DAY_MS;
    let rows = await read(end, stepHours);
    if (rows && rows.length >= TXN_HISTORY_ROW_CAP) {
      rows = [];
      for (let h = 0; h < stepHours; h += R7_SLICE_HOURS) {
        const slice = await read(end - h * 3_600_000, R7_SLICE_HOURS);
        if (!slice || slice.length >= TXN_HISTORY_ROW_CAP) {
          return { status: "unchecked", reason: `the card has more than ${TXN_HISTORY_ROW_CAP} transactions in a 3-day slice of the month before the disputed charge` };
        }
        rows.push(...slice);
      }
    }
    if (!rows) return { status: "unchecked", reason: "the transaction history call failed" };
    const from = cursor - R7_MONTH_MAX_DAYS * DAY_MS;
    const hits = rows
      .filter(
        (r) =>
          r.product_cd === flagged.product_cd &&
          Math.abs(r.amount_usd - flagged.amount_usd) < 0.005 &&
          parseToolTs(r.ts) >= from &&
          parseToolTs(r.ts) <= end,
      )
      .map((r) => parseToolTs(r.ts))
      .sort((a, b) => b - a);
    matches += hits.length;
    if (hits.length === 0) return { status: "not_recurring", matches, windowStep: step };
    cursor = hits[0]!;
    months += 1;
  }
  return { status: "recurring", months, matches };
}

/**
 * A customer_report trigger is the cardholder's own statement that they did
 * not make the charge -- the case pack's trigger text reads "I never made this
 * $49.00 purchase". That is the denial R2 acts on, recorded at the moment the
 * case opened, not a reply we would have to simulate. Unless R7's recurring
 * pattern applies, it sets `customer_denied`, which the policy engine already
 * honours: BLOCK_CARD's R1 prerequisite, "strongly suspected" for the SAR test
 * (§3a), and README line 255's "open a case whenever a customer disputes".
 */
async function dispute(g: GatherRuntime): Promise<void> {
  const f = g.facts;
  if (f.trigger.kind !== "customer_report") return;
  const t = f.trigger;
  const txnId = f.txn?.id ?? t.txn_ids?.[0] ?? null;

  let check: RecurringCheck = { status: "unchecked", reason: "no card and disputed transaction were resolved" };
  if (f.primary_card && txnId) {
    // R7 looks back from the disputed charge, so the history is read as of
    // that charge when its time is known -- earlier charges are all R7 needs,
    // and the disputed row is then always inside the result. Read as of the
    // case, a card with more than 500 transactions in 120 days lost the
    // disputed charge to the row cap, and the evidence said it was "not in the
    // card's 120-day history" (CC-2394: 1,518 rows, the 500 newest reaching
    // back to 2 Aug, the dispute on 31 Jul).
    const anchor = f.txn_ts && parseToolTs(f.txn_ts) <= parseToolTs(g.asOf) ? f.txn_ts : g.asOf;
    const res = await g.catalog.get_transaction_history(f.primary_card, { days: R7_LOOKBACK_DAYS }, anchor);
    if (res.ok) {
      const rows = ((res.data as { rows?: HistoryRowWithProduct[] }).rows ?? []);
      check = checkRecurringCharge(rows, txnId, rows.length >= TXN_HISTORY_ROW_CAP);
      const flagged = rows.find((r) => r.txn_id === txnId);
      if (check.status === "unchecked" && rows.length >= TXN_HISTORY_ROW_CAP && flagged?.product_cd) {
        check = await checkRecurringByMonthlyWindows(g, f.primary_card, flagged);
      }
    } else {
      check = { status: "unchecked", reason: "the transaction history call failed" };
    }
  }
  // R7 is an exception that needs a match; an unchecked pattern leaves R2 in force.
  if (check.status === "recurring") f.dispute_recurring = true;
  else f.customer_denied = true;

  const customer: EvidenceEntityRef = f.customer ?? { type: "Customer", id: t.customer_id };
  const txnRef: EvidenceEntityRef | null = f.txn ?? (txnId ? { type: "Transaction", id: txnId } : null);
  const entities = txnRef ? [customer, txnRef] : [customer];
  await g.onEvidence({
    id: g.idGen.next("customer_report"),
    category: "customer_response",
    summary: `Cardholder ${t.customer_id} disputed ${txnId ? `transaction ${txnId}` : "a charge"} when opening this case: "${t.text}"`,
    entities,
    source_tool: "customer_report",
    weight_hint: 0.8,
    supports: ["fraud"],
    contradicts: [],
    ts: g.asOf,
  });

  const basis = "same amount and product code a month apart; the dataset has no merchant field, so the product code stands in for it";
  let summary: string;
  if (check.status === "recurring") {
    summary = `R7 applies: the disputed charge repeats ${check.months} earlier monthly charge(s) on this card (${basis}). A forgotten recurring charge is not fraud, so the card must not be blocked.`;
  } else if (check.status === "not_recurring" && check.windowStep !== undefined) {
    const from = check.windowStep === 0 ? "the disputed charge" : `the earlier repeat found ${check.windowStep} month(s) back`;
    summary = `R7 checked and does not apply: no charge of the same amount and product code falls ${R7_MONTH_MIN_DAYS}-${R7_MONTH_MAX_DAYS} days before ${from}. The card is too busy for its ${TXN_HISTORY_ROW_CAP}-row history to cover ${R7_LOOKBACK_DAYS} days, so only those monthly windows were read (${basis}). R2 governs the dispute.`;
  } else if (check.status === "not_recurring") {
    summary = `R7 checked and does not apply: ${check.matches} earlier charge(s) of the same amount and product code in ${R7_LOOKBACK_DAYS} days, none forming a monthly cadence (${basis}). R2 governs the dispute.`;
  } else {
    summary = `R7 could not be checked: ${check.reason}. R2 governs the dispute.`;
  }
  await g.onEvidence({
    id: g.idGen.next("get_transaction_history"),
    category: "txn_behavior",
    summary,
    entities,
    source_tool: "get_transaction_history",
    weight_hint: check.status === "recurring" ? 0.7 : 0.2,
    supports: check.status === "recurring" ? ["legitimate"] : [],
    contradicts: check.status === "recurring" ? ["fraud"] : [],
    ts: g.asOf,
  });
}

export async function runStandardGather(g: GatherRuntime): Promise<void> {
  await resolveTrigger(g);
  await txnHistory(g);
  await dispute(g);
  await baseline(g);
  await rings(g);
  await priorCases(g);
  // Added after an audit against CHALLENGE_BRIEF's "The agent" list found six
  // catalog tools that were never called on any case. These four close the gaps
  // that list names explicitly: graph pattern detection, account behaviour,
  // case-memory retrieval and external data. Budget is 25 calls
  // (DEFAULT_MAX_TOOL_CALLS) against roughly 8 used before this, so the sweep
  // still leaves room for the evidence rounds.
  await patterns(g);
  await velocity(g);
  await similarCases(g);
  await flaggedTxnProfile(g);
  rescopeUndocumented(g);
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