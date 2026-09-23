import type { EvidenceItem, Hypothesis } from "@hhgoa/contracts";

/**
 * A decision model as the agent's pattern scorer: TypeSafe's hosted Jev
 * (System One API) by default, or a local Kev (github.com/jaredpalmer/kev),
 * which serves the same API.
 *
 * A decision model takes a text state plus typed questions and returns a
 * probability distribution per question, no generated text. The organiser
 * allows such models "for routing and scoring inside your agent, but you will
 * still need an LLM for the actual answers" (docs/decisions.md), so the scorer
 * only ranks which documented pattern a case fits; the LLM keeps the
 * fraud-vs-legitimate judgement the answer is built from.
 *
 * It answers one question: which of the five documented patterns. It is never
 * asked whether a case is fraud: in the closed-case history every cardholder
 * dispute was confirmed fraud and every model alert was cleared, so fraud vs
 * legitimate there is the trigger kind, which is also why the state leaves out
 * the dispute text and the trigger. `undocumented` is not an option; the
 * graph's anonymous-proxy ring gate still names it.
 *
 * What leaves the machine for the hosted API is this state alone: evidence
 * summaries with customer, card, case and device identifiers replaced by
 * counts or placeholders (see `compact`).
 *
 * The state is rendered from the same EvidenceItems the assessor sees, by this
 * one function, both for the Kev training export and at inference.
 */

export const SCORER_PATTERNS = [
  "card_testing",
  "card_not_present_fraud",
  "card_not_present_new_device",
  "out_of_region_use",
  "account_takeover",
] as const;
export type ScorerPattern = (typeof SCORER_PATTERNS)[number];

/** Option descriptions quoted from docs/DATASET_README.md "Known fraud patterns". */
const PATTERN_CRITERIA: Record<ScorerPattern, string> = {
  card_testing:
    "A stolen card number is checked before use: three or more tiny online authorizations, often under $5, then a larger purchase.",
  card_not_present_fraud:
    "The number is used online without the card. Amounts and products that don't fit the cardholder's history, often in a burst of two to four within 48 hours.",
  card_not_present_new_device:
    "Card-not-present fraud with the identity record marking the device as New for this account, sometimes behind a proxy.",
  out_of_region_use:
    "Card-present purchases in a billing region the cardholder has no history in, while their normal activity continues at home.",
  account_takeover:
    "Mixed-channel activity inconsistent with the cardholder, often with device and match-flag anomalies, pointing to stolen credentials rather than a stolen number.",
};

export const PATTERN_QUESTION = {
  type: "choice" as const,
  instructions: "Treating this card case as fraud, which documented fraud pattern does the evidence fit best?",
  criteria: PATTERN_CRITERIA,
};

/**
 * How much evidence a scorer's state may carry. Kev trains on at most
 * --max_state tokens (384 by default, 512 in our fine-tune); ~1,400 chars is
 * ~500 tokens, so its lines are capped. Jev is served (8k context) and never
 * trained on our states, so it gets every line whole: at 220 chars the cap cut
 * the conclusions off the pattern-shape and region lines ("...a charge where
 * the card is normally used does not fit ..." lost "out-of-region use",
 * CC-1665, iteration 15).
 */
export interface StateLimits {
  charBudget: number;
  lineCap: number;
  /**
   * Prefix each item's line with its weight and the patterns it supports or
   * contradicts -- the same annotations the assessor's brief carries
   * (contextBuilder.ts). Without them Jev read every line at face value: the
   * account-takeover detector (held-out precision 0.35, firing on 95% of
   * out-of-region cases) and the mixed-channel line matched the README's ATO
   * wording, while the away-region line that separates the two (76% of OOR vs
   * 9% of ATO) carried no mark of its weight. All three OOR cases went to ATO
   * in iterations 15-16. Off for Kev until it is trained on annotated states.
   */
  annotate?: boolean;
}
export const KEV_STATE_LIMITS: StateLimits = { charBudget: 1400, lineCap: 220 };
export const SERVED_STATE_LIMITS: StateLimits = { charBudget: 6000, lineCap: 1000, annotate: true };

/** "(weight 0.75; supports out_of_region_use; contradicts account_takeover) " */
function annotation(it: EvidenceItem): string {
  const parts = [`weight ${it.weight_hint.toFixed(2)}`];
  if (it.supports.length) parts.push(`supports ${it.supports.join(", ")}`);
  if (it.contradicts.length) parts.push(`contradicts ${it.contradicts.join(", ")}`);
  return `(${parts.join("; ")}) `;
}

const SOURCE_ORDER = [
  "detect_patterns",
  "get_transaction_history",
  "get_entity_profile",
  "get_baseline_deviation",
  "compute_velocity",
  "find_prior_cases",
  "retrieve_similar_cases",
  "find_shared_entity_rings",
  "get_community",
];

function excluded(item: EvidenceItem): boolean {
  // Dispute text: confounded with the outcome in the training history.
  if (item.category === "customer_response") return true;
  // A static local lookup table (see lookup_external's own note), not case evidence.
  if (item.source_tool === "lookup_external") return true;
  // R7 only runs on disputes, so its line would tell Kev the trigger kind.
  if (item.summary.startsWith("R7 ")) return true;
  return false;
}

/** Replaces id lists with their length so the state carries counts, not identifiers. */
function compact(summary: string): string {
  return summary
    .replace(/txn\(s\) (\d+(?:, \d+)*)/g, (_m, ids: string) => `${ids.split(", ").length} txn(s)`)
    .replace(/case\(s\) (CC-\d+(?:, CC-\d+)*)/g, (_m, ids: string) => `${ids.split(", ").length} case(s)`)
    .replace(/\(pattern ([a-z_]+(?:\/[a-z_]+)*)\)/g, (_m, list: string) => `(patterns: ${tally(list.split("/"))})`)
    .replace(/\bcard\(s\) ([CX]\d+-K\d+(?:, [CX]\d+-K\d+)*)/g, (_m, ids: string) => `${ids.split(", ").length} card(s)`)
    // Region codes stay: the region lines' own grammar needs them ("is in
    // billing region 330, the card's usual region"), and stripping them left
    // "is in billing region, the card's usual region" (iteration 15).
    .replace(/\bregion (\d+)\.0+\b/g, "region $1")
    .replace(/\bcomm_\S+/g, "a community")
    .replace(/\b[0-9a-f]{16}\b/g, "#")
    .replace(/\bC\d{5}\b/g, "the customer")
    .replace(/\s+/g, " ")
    .trim();
}

function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(", ");
}

function cap(line: string, lineCap: number): string {
  return line.length <= lineCap ? line : `${line.slice(0, lineCap - 3)}...`;
}

function similarCasesLine(items: EvidenceItem[]): string | null {
  if (items.length === 0) return null;
  const outcomes = new Map<string, number>();
  const overlaps = new Map<string, number>();
  let best = 0;
  for (const it of items) {
    const m = /\(score ([\d.]+), (\w+)\)/.exec(it.summary);
    if (m) {
      best = Math.max(best, Number(m[1]));
      outcomes.set(m[2]!, (outcomes.get(m[2]!) ?? 0) + 1);
    }
    for (const o of ["same customer", "shared card", "shared billing region", "shared device", "similar exposure band"]) {
      if (it.summary.includes(o)) overlaps.set(o, (overlaps.get(o) ?? 0) + 1);
    }
  }
  const out = [...outcomes.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
  const ov = [...overlaps.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
  return `Similar closed cases: ${items.length} (${out}); best score ${best.toFixed(2)}${ov ? `; overlaps: ${ov}` : ""}`;
}

function ringsLines(items: EvidenceItem[], annotate = false): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  let specific = 0;
  let tooLarge = 0;
  for (const it of items) {
    if (it.summary.includes("too large a group")) tooLarge++;
    else if (it.summary.startsWith("Activity shares")) specific++;
    else lines.push((annotate ? annotation(it) : "") + compact(it.summary));
  }
  lines.unshift(`Shared-entity rings: ${specific} specific shared device profile(s); ${tooLarge} shared profile(s) too common to be a ring`);
  return lines;
}

/** The compact text state Kev scores, built only from agent-visible evidence. */
export function renderScorerState(
  evidence: readonly EvidenceItem[],
  limits: StateLimits = KEV_STATE_LIMITS,
): string {
  const kept = evidence.filter((e) => !excluded(e));
  const bySource = new Map<string, EvidenceItem[]>();
  for (const e of kept) {
    const list = bySource.get(e.source_tool);
    if (list) list.push(e);
    else bySource.set(e.source_tool, [e]);
  }
  const sources = [
    ...SOURCE_ORDER.filter((s) => bySource.has(s)),
    ...[...bySource.keys()].filter((s) => !SOURCE_ORDER.includes(s)).sort(),
  ];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const items = bySource.get(source)!;
    let rendered: string[];
    if (source === "retrieve_similar_cases") rendered = [similarCasesLine(items)].filter((l): l is string => l !== null);
    else if (source === "find_shared_entity_rings") rendered = ringsLines(items, limits.annotate);
    else rendered = items.map((it) => (limits.annotate ? annotation(it) : "") + compact(it.summary));
    for (const line of rendered) {
      const c = cap(line, limits.lineCap);
      if (seen.has(c)) continue;
      seen.add(c);
      lines.push(`- ${c}`);
    }
  }
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limits.charBudget) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

export interface PatternScore {
  choice: ScorerPattern;
  confidence: number;
  probabilities: Record<ScorerPattern, number>;
}

export interface PatternScorer {
  /** Short id for the tool trail, e.g. "jev" or "kev". */
  readonly name: string;
  /** How much state it takes; defaults to Kev's training-sized limits. */
  readonly stateLimits?: StateLimits;
  scorePattern(state: string): Promise<PatternScore>;
}

interface SystemOneResponse {
  answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
}

export interface SystemOneOptions {
  name: string;
  /** Base URL; the request goes to `${baseUrl}/v1/systemone`. */
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer <apiKey>`; the hosted API requires it. */
  apiKey?: string;
  timeoutMs?: number;
  /** Retries after 429 / 5xx, with exponential backoff (TypeSafe's documented strategy). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  stateLimits?: StateLimits;
}

/**
 * Client for TypeSafe's System One API: the hosted Jev model
 * (https://api.typesafe.ai, model `jev-latest`) or a local Kev server, which
 * serves the same contract.
 */
export class SystemOneScorer implements PatternScorer {
  readonly name: string;
  readonly stateLimits: StateLimits;
  constructor(private readonly opts: SystemOneOptions) {
    this.name = opts.name;
    this.stateLimits = opts.stateLimits ?? KEV_STATE_LIMITS;
  }

  async scorePattern(state: string): Promise<PatternScore> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const retries = this.opts.maxRetries ?? 3;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`;
    const body = JSON.stringify({ state, model: this.opts.model, questions: { pattern: PATTERN_QUESTION } });
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/systemone`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      if (res.ok) return parsePatternAnswer(this.name, (await res.json()) as SystemOneResponse);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new Error(`${this.name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

function parsePatternAnswer(name: string, body: SystemOneResponse): PatternScore {
  const answer = body.answers?.["pattern"];
  const probs = answer?.probabilities;
  if (!answer || !probs || typeof answer.choice !== "string") throw new Error(`${name}: response has no pattern answer`);
  const probabilities = {} as Record<ScorerPattern, number>;
  for (const p of SCORER_PATTERNS) {
    const v = probs[p];
    if (typeof v !== "number") throw new Error(`${name}: no probability for ${p}`);
    probabilities[p] = v;
  }
  if (!(SCORER_PATTERNS as readonly string[]).includes(answer.choice)) throw new Error(`${name}: unknown choice ${answer.choice}`);
  return { choice: answer.choice as ScorerPattern, confidence: answer.confidence ?? 0, probabilities };
}

/**
 * PATTERN_SCORER=jev|kev|none picks the scorer. Unset: Jev when JEV_API_KEY is
 * set, else a local Kev when KEV_URL is set, else none (the assessor's own
 * ranking stands).
 */
export function patternScorerFromEnv(env: NodeJS.ProcessEnv = process.env): PatternScorer | null {
  const choice = env["PATTERN_SCORER"] ?? (env["JEV_API_KEY"] ? "jev" : env["KEV_URL"] ? "kev" : "none");
  if (choice === "none") return null;
  if (choice === "jev") {
    const apiKey = env["JEV_API_KEY"];
    if (!apiKey) throw new Error("PATTERN_SCORER=jev needs JEV_API_KEY");
    return new SystemOneScorer({ name: "jev", baseUrl: env["JEV_URL"] ?? "https://api.typesafe.ai", model: "jev-latest", apiKey, stateLimits: SERVED_STATE_LIMITS });
  }
  if (choice === "kev") {
    const baseUrl = env["KEV_URL"];
    if (!baseUrl) throw new Error("PATTERN_SCORER=kev needs KEV_URL");
    return new SystemOneScorer({ name: "kev", baseUrl, model: "kev-latest" });
  }
  throw new Error(`PATTERN_SCORER must be jev, kev or none, got "${choice}"`);
}

/**
 * Re-ranks the documented-pattern hypotheses by Kev's distribution while
 * keeping the assessor's fraud-vs-legitimate judgement exactly as it was.
 *
 * The documented patterns' total mass D is the LLM's; Kev only decides how D
 * splits across the five patterns. `legitimate` and `undocumented` keep their
 * probabilities, so the fraud probability, the verdict and the risk level are
 * unchanged. A pattern the assessor did not propose gets its supporting and
 * contradicting ids from the evidence items that name it.
 */
export function applyPatternScore(
  hypotheses: readonly Hypothesis[],
  score: PatternScore,
  evidence: readonly EvidenceItem[],
): Hypothesis[] {
  const documented = new Set<string>(SCORER_PATTERNS);
  const mass = hypotheses.filter((h) => documented.has(h.fraud_type)).reduce((s, h) => s + h.probability, 0);
  if (mass <= 0) return [...hypotheses];
  const kept = hypotheses.filter((h) => !documented.has(h.fraud_type));
  const byType = new Map(hypotheses.map((h) => [h.fraud_type, h]));
  const rescored: Hypothesis[] = SCORER_PATTERNS.map((p) => {
    const prior = byType.get(p);
    return {
      fraud_type: p,
      probability: Math.round(mass * score.probabilities[p] * 1e6) / 1e6,
      supporting: prior?.supporting ?? evidence.filter((e) => e.supports.includes(p)).map((e) => e.id),
      contradicting: prior?.contradicting ?? evidence.filter((e) => e.contradicts.includes(p)).map((e) => e.id),
    };
  });
  // Rounding residue goes to Kev's top pattern so the total stays the LLM's mass.
  const residue = mass - rescored.reduce((s, h) => s + h.probability, 0);
  const top = rescored.find((h) => h.fraud_type === score.choice)!;
  top.probability = Math.max(0, top.probability + residue);
  return [...rescored.filter((h) => h.probability > 0), ...kept];
}
