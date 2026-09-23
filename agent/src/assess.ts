import { z } from "zod";
import {
  AssessmentSchema,
  RiskLevelSchema,
  type Assessment,
  type EvidenceCategory,
  type EvidenceItem,
  type Hypothesis,
  type RiskLevel,
  type Sufficiency,
} from "@hhgoa/contracts";
import { structuredCall, type StructuredCallResult } from "./structured.js";
import type { LlmClient } from "./llm.js";
import type { Trigger } from "@hhgoa/contracts";

/**
 * Assessor (PRD §9.3). The LLM proposes hypotheses + a risk/confidence
 * estimate through `structuredCall`; the *code* then enforces hard rules
 * that the local model must not be allowed to violate:
 *
 *  - the confidence guard: cap by independent evidence categories
 *    (<2 categories → 0.45, 2 → 0.65, ≥3 → uncapped; contradicting
 *    evidence at/above the contradiction threshold downgrades the cap one
 *    tier, floor 0.45), and
 *  - a `legitimate` hypothesis is always present.
 *
 * The schema the LLM fills in (`AssessmentProposalSchema`) is deliberately
 * smaller than `AssessmentSchema` (no `sufficiency`): sufficiency is a
 * machine decision made by the stop rule, not something the model should
 * be allowed to assert.
 */

/**
 * The zod object the LLM must emit (proposal only; no sufficiency).
 * Nested objects are kept structural so any fraud_type string is accepted;
 * `finalizeAssessment` normalizes names into the PatternSchema vocabulary.
 */
export const AssessmentProposalSchema = z.object({
  hypotheses: z.array(
    z.object({
      fraud_type: z.string(),
      probability: z.number().min(0).max(1),
      supporting: z.array(z.string()),
      contradicting: z.array(z.string()),
    }),
  ),
  risk_level: RiskLevelSchema,
  risk_score: z.number(),
  confidence: z.number().min(0).max(1),
  legit_hypothesis_probability: z.number().min(0).max(1),
});
export type AssessmentProposal = z.infer<typeof AssessmentProposalSchema>;

/**
 * `AssessmentProposalSchema` as JSON Schema, for grammar-constrained
 * decoding. Written out by hand rather than derived: the project is on zod
 * 3, whose objects `zod/v4`'s toJSONSchema cannot read, and this shape is
 * small and changes with the schema right above it.
 */
// Grammar-constrained decoding follows the schema exactly, so anything the
// schema leaves open the model may keep emitting: unbounded `hypotheses` let a
// run generate 11k+ tokens in a single call and stall the batch. Bounding the
// arrays is what stops that -- a max_tokens cap would truncate mid-object and
// turn a slow case into unparseable JSON.
const FRAUD_TYPE_ENUM = [
  "card_testing",
  "card_not_present_fraud",
  "card_not_present_new_device",
  "out_of_region_use",
  "account_takeover",
  // Offered so the model can put probability on graph evidence that supports
  // it (the cross-card device ring), but never trusted as a label on its own:
  // resolvePatternLabel() keeps it only with graph support.
  "undocumented",
  "legitimate",
] as const;
/** One per fraud type, at most. */
const MAX_HYPOTHESES = FRAUD_TYPE_ENUM.length;
const EVIDENCE_REF = { type: "string", maxLength: 300 } as const;

export const ASSESSMENT_PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheses", "risk_level", "risk_score", "confidence", "legit_hypothesis_probability"],
  properties: {
    hypotheses: {
      type: "array",
      minItems: 1,
      maxItems: MAX_HYPOTHESES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fraud_type", "probability", "supporting", "contradicting"],
        properties: {
          // Free-form here meant any invented label fell through
          // canonicalPattern() to "undocumented", a pattern that appears in 9
          // of 5565 closed cases. It is now an explicit enum member, guarded by
          // resolvePatternLabel().
          fraud_type: { type: "string", enum: [...FRAUD_TYPE_ENUM] },
          probability: { type: "number", minimum: 0, maximum: 1 },
          supporting: { type: "array", maxItems: 6, items: EVIDENCE_REF },
          contradicting: { type: "array", maxItems: 6, items: EVIDENCE_REF },
        },
      },
    },
    risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
    risk_score: { type: "number" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    legit_hypothesis_probability: { type: "number", minimum: 0, maximum: 1 },
  },
};

/** Evidence weighing at/above this is "material" for the contradiction rule. */
/** Stage 1 output: which patterns fit, with their evidence. No numbers. */
export const TriageProposalSchema = z.object({
  candidates: z.array(
    z.object({
      fraud_type: z.string(),
      fits: z.boolean(),
      supporting: z.array(z.string()),
      contradicting: z.array(z.string()),
    }),
  ),
});
export type TriageProposal = z.infer<typeof TriageProposalSchema>;

export const TRIAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      minItems: 1,
      maxItems: MAX_HYPOTHESES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fraud_type", "fits", "supporting", "contradicting"],
        properties: {
          fraud_type: { type: "string", enum: [...FRAUD_TYPE_ENUM] },
          fits: { type: "boolean" },
          supporting: { type: "array", maxItems: 6, items: EVIDENCE_REF },
          contradicting: { type: "array", maxItems: 6, items: EVIDENCE_REF },
        },
      },
    },
  },
};

export const CONTRADICTION_WEIGHT_THRESHOLD = 0.55;

/** Confidence cap by number of independent evidence categories (PRD §9.3). */
export function confidenceCap(categoryCount: number): number {
  if (categoryCount >= 3) return 1;
  if (categoryCount === 2) return 0.65;
  return 0.45;
}

/** True when evidence with material weight contradicts the top hypothesis. */
export function hasStrongContradiction(
  evidence: EvidenceItem[],
  topFraudType: string | null,
  threshold: number = CONTRADICTION_WEIGHT_THRESHOLD,
): boolean {
  return evidence.some(
    (e) => topFraudType !== null && e.contradicts.includes(topFraudType) && e.weight_hint >= threshold,
  );
}

/** Downgrade the cap one tier when contradicted (floor 0.45). */
export function applyContradictionCap(baseCap: number, contradicted: boolean): number {
  if (!contradicted) return baseCap;
  if (baseCap >= 1) return 0.65;
  if (baseCap === 0.65) return 0.45;
  return 0.45;
}

export function distinctEvidenceCategories(evidence: EvidenceItem[]): EvidenceCategory[] {
  return [...new Set(evidence.map((e) => e.category))];
}

/** Top non-"legitimate" hypothesis; null if only legitimate remain. */
/**
 * The pattern label a case files, before the legitimate/none mapping.
 *
 * `undocumented` is a graph finding here, not a model guess. When the flagged
 * charge's device is the cross-card anonymous-proxy ring it names the pattern
 * whichever documented label the model leaned toward -- measured, that ring
 * fires on 4 of 9 undocumented closed cases and on none of the other 5,556.
 * Without the ring, a model that reaches for `undocumented` gets its best
 * documented alternative instead: the old free-form label filed
 * "fraud / undocumented" on cases the graph gave no reason to call novel.
 */
export function resolvePatternLabel(
  assessment: Pick<Assessment, "hypotheses">,
  graphUndocumented: boolean,
): string {
  if (graphUndocumented) return "undocumented";
  const documented = assessment.hypotheses
    .filter((h) => h.fraud_type !== "legitimate" && h.fraud_type !== "undocumented")
    .sort((a, b) => b.probability - a.probability)[0];
  return canonicalPattern(documented?.fraud_type ?? null);
}

export function topFraudHypothesis(assessment: Pick<Assessment, "hypotheses">): Hypothesis | null {
  const nonLegit = assessment.hypotheses.filter((h) => h.fraud_type !== "legitimate");
  if (nonLegit.length === 0) return null;
  return [...nonLegit].sort((a, b) => b.probability - a.probability)[0] ?? null;
}

/**
 * Probability that this case is fraud.
 *
 * When no fraud hypothesis survives, the assessment holds only a
 * `legitimate` one — and the old fallback read that hypothesis's probability
 * *as* the fraud probability, inverting it. A case the model was certain was
 * legitimate filed `fraud_probability: 1.0` and was then read as fraud by
 * every probability band downstream (HHG-006 closed as fraud at p=1.0 while
 * recommending ALLOW_TRANSACTION, because recommendActions read the same
 * assessment through topFraudHypothesis and correctly saw 0).
 */
export function fraudProbability(assessment: Pick<Assessment, "hypotheses" | "legit_hypothesis_probability">): number {
  // Total fraud mass, not the top pattern's share. docs/DATASET_README.md
  // line 324 defines fraud_probability as "how likely the flagged activity is
  // fraud" -- a question about fraud vs legitimate, not about which pattern.
  // Reading only the top type split the mass whenever the model hedged
  // between patterns: CC-5475 (gold account_takeover) came back ATO 0.35,
  // out_of_region 0.25, cnp_fraud 0.20, legitimate 0.20 -- 80% fraud -- and
  // closed `legitimate` because 0.35 <= 0.40. The pattern is still the argmax
  // fraud type (topFraudHypothesis); only the fraud-vs-legitimate decision
  // reads the sum.
  const fraudMass = assessment.hypotheses
    .filter((h) => h.fraud_type !== "legitimate")
    .reduce((s, h) => s + h.probability, 0);
  if (fraudMass > 0) return boundProbability(fraudMass);
  const legit = assessment.legit_hypothesis_probability;
  return boundProbability(typeof legit === "number" ? 1 - legit : 0);
}

/**
 * The filed probability never claims certainty. It is an estimate from a
 * finite history (the proxy-device ring behind HHG-014 has 4 historical
 * cases), so 0 and 1 are not supported by the evidence; the assessor filed
 * HHG-014 at 1.00 by putting 0 on the legitimate reading. Every policy
 * threshold (0.15, 0.30, 0.40, 0.70) lies well inside these bounds, so no
 * decision changes; only the reported number stops overstating certainty.
 */
export const MIN_FRAUD_PROBABILITY = 0.01;
export const MAX_FRAUD_PROBABILITY = 0.99;

function boundProbability(p: number): number {
  return Math.min(MAX_FRAUD_PROBABILITY, Math.max(MIN_FRAUD_PROBABILITY, p));
}

export function legitHypothesis(assessment: Pick<Assessment, "hypotheses">): Hypothesis | null {
  return assessment.hypotheses.find((h) => h.fraud_type === "legitimate") ?? null;
}

export function deriveRiskLevel(topProb: number): RiskLevel {
  if (topProb >= 0.85) return "CRITICAL";
  if (topProb >= 0.6) return "HIGH";
  if (topProb >= 0.3) return "MEDIUM";
  return "LOW";
}

/** The strongest fraud-pattern label the evidence supports, if any. */
export function evidenceTopPattern(evidence: EvidenceItem[]): string | null {
  const candidates = new Map<string, number>();
  for (const e of evidence) {
    for (const s of e.supports) {
      if (s === "fraud" || s === "legitimate") continue;
      candidates.set(s, (candidates.get(s) ?? 0) + e.weight_hint);
    }
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const [pattern, score] of candidates) {
    if (score > bestScore) {
      best = pattern;
      bestScore = score;
    }
  }
  return best;
}

/** Map a hypothesis fraud_type onto the PatternSchema's vocabulary. */
export function canonicalPattern(fraudType: string | null): string {
  if (!fraudType || fraudType === "legitimate") return "none";
  const known = [
    "card_testing",
    "card_not_present_fraud",
    "card_not_present_new_device",
    "out_of_region_use",
    "account_takeover",
    "undocumented",
  ];
  return known.includes(fraudType) ? fraudType : "undocumented";
}

/**
 * Build the final, validated `Assessment` from a model proposal. Enforces:
 *   1. a `legitimate` hypothesis always exists,
 *   2. probabilities are non-negative and sum to 1 (residual → legitimate),
 *   3. the confidence guard (category cap + contradiction downgrade),
 *   4. risk_level is re-derived from top-fraud probability, and
 *   5. `sufficiency` is attached exactly as the caller (stop rule) decides.
 */
export function finalizeAssessment(
  proposal: AssessmentProposal,
  evidence: EvidenceItem[],
  sufficiency: Sufficiency,
): Assessment {
  let hypotheses: Hypothesis[] = proposal.hypotheses.map((h) => ({
    fraud_type: h.fraud_type,
    probability: Math.max(0, h.probability),
    supporting: h.supporting,
    contradicting: h.contradicting,
  }));

  if (!hypotheses.some((h) => h.fraud_type === "legitimate")) {
    hypotheses.push({
      fraud_type: "legitimate",
      probability: 0.01,
      supporting: [],
      contradicting: [],
    });
  }

  const sum = hypotheses.reduce((s, h) => s + h.probability, 0);
  if (sum <= 0) {
    hypotheses = hypotheses.map((h) => ({
      ...h,
      probability: h.fraud_type === "legitimate" ? 1 : 0,
    }));
  } else if (Math.abs(sum - 1) > 1e-6) {
    const scale = 1 / sum;
    hypotheses = hypotheses.map((h) => ({
      ...h,
      probability: Math.round(h.probability * scale * 1e6) / 1e6,
    }));
    const postSum = hypotheses.reduce((s, h) => s + h.probability, 0);
    const legit = hypotheses.find((h) => h.fraud_type === "legitimate");
    if (legit && Math.abs(postSum - 1) > 1e-6) {
      legit.probability = Math.max(0, Math.min(1, legit.probability + (1 - postSum)));
    }
  }

  const topType = topFraudHypothesis({ hypotheses })?.fraud_type ?? null;
  // Risk level follows the fraud mass, same as the verdict (see fraudProbability).
  const topProb = fraudProbability({ hypotheses, legit_hypothesis_probability: proposal.legit_hypothesis_probability });
  const legit = hypotheses.find((h) => h.fraud_type === "legitimate");
  const legitProb = legit?.probability ?? (proposal.legit_hypothesis_probability ?? 0);

  const cats = distinctEvidenceCategories(evidence);
  const cap = applyContradictionCap(
    confidenceCap(cats.length),
    hasStrongContradiction(evidence, topType),
  );
  const confidence = Math.min(proposal.confidence, cap);

  const assessment: Assessment = {
    hypotheses,
    risk_level: deriveRiskLevel(topProb),
    risk_score: proposal.risk_score,
    confidence,
    sufficiency,
    legit_hypothesis_probability: legitProb,
  };

  return AssessmentSchema.parse(assessment);
}

/**
 * Deterministic fallback proposal (PRD §13: every run completes without a
 * usable model). Conservative — never asserts strong fraud on the model's
 * behalf; derived only from evidence the machine already holds.
 */
export function fallbackAssessmentProposal(
  trigger: Trigger,
  evidence: EvidenceItem[],
): AssessmentProposal {
  const pattern = evidenceTopPattern(evidence);
  const baseline = trigger.kind === "risk_score" ? trigger.risk_score : 0.5;
  const strongest = evidence.reduce((m, e) => Math.max(m, e.weight_hint), 0);
  const prob = Math.min(0.55, Math.max(0.3, baseline, strongest));
  const topFraud = pattern ?? "undocumented";
  return {
    hypotheses: [
      {
        fraud_type: topFraud,
        probability: Math.round(prob * 100) / 100,
        supporting: [],
        contradicting: [],
      },
      { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: [] },
    ],
    risk_level: "MEDIUM",
    risk_score: baseline,
    confidence: 0.5,
    legit_hypothesis_probability: 0.1,
  };
}

export interface AssessOptions {
  llm: LlmClient;
  /** Single-call prompt; also the fallback when the two-stage path degrades. */
  systemPrompt: string;
  /** Stage 1 (classification). Omit to keep the original single-call path. */
  triageSystemPrompt?: string;
  /** Stage 2 (calibration over stage 1's findings). */
  calibrateSystemPrompt?: string;
  /**
   * 1 = single call under `systemPrompt` (classify + calibrate in one reply);
   * 2 = triage then calibrate. Measured on the same leak-free 20-case sample
   * with the same evidence: single-stage 47.1% pattern exact, 0/17 false
   * negatives, 85% decision agreement; two-stage 17.6%, 6/17, 60%. The split
   * let a 7B triage delete fraud hypotheses before anything scored them and
   * mis-classified broadly (account_takeover became the magnet). Default 1.
   */
  stages?: 1 | 2;
  contextText: string;
  trigger: Trigger;
  evidence: EvidenceItem[];
  sufficiency: Sufficiency;
}

export interface AssessOutput {
  assessment: Assessment;
  structured: StructuredCallResult<AssessmentProposal>;
}

/** Render stage 1's surviving candidates as the brief stage 2 calibrates. */
export function renderTriageForCalibration(triage: TriageProposal, evidence: EvidenceItem[]): string {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const describe = (ids: string[]): string => {
    const lines = ids
      .map((id) => byId.get(id))
      .filter((e): e is EvidenceItem => Boolean(e))
      .map((e) => `      - ${e.id} (${e.category}, weight ${e.weight_hint.toFixed(2)}): ${e.summary}`);
    return lines.length ? lines.join("\n") : "      - (none)";
  };
  const fitting = triage.candidates.filter((c) => c.fits);
  let kept = fitting.length > 0 ? fitting : triage.candidates;

  // Calibration must always score at least one fraud hypothesis. Triage
  // classifies; it does not get to decide the case. On a thin brief a 7B
  // triage marks every fraud pattern fits=false and `legitimate` fits=true
  // (the exculpatory items give it "specific evidence"), so `kept` held only
  // `legitimate`, calibration never saw a fraud alternative, and
  // finalizeAssessment read topFraud as absent -> probability exactly 0 ->
  // `legitimate`/`none`. That turned three confirmed-fraud cases into false
  // negatives in one 20-case run (CC-4386, CC-2247, CC-5194) after the
  // single-stage assessor, whose schema always carried both, had 0/17.
  // Hand calibration the best-supported fraud candidate regardless, flagged
  // as un-endorsed, so it gets an honest number rather than a silent zero.
  const keptHasFraud = kept.some((c) => c.fraud_type !== "legitimate");
  const unendorsed = new Set<string>();
  if (!keptHasFraud) {
    const fraudCands = triage.candidates.filter((c) => c.fraud_type !== "legitimate");
    if (fraudCands.length > 0) {
      const best = fraudCands.reduce((a, b) => (b.supporting.length > a.supporting.length ? b : a));
      kept = [...kept, best];
      unendorsed.add(best.fraud_type);
    }
  }

  return kept
    .map(
      (c) =>
        `Hypothesis: ${c.fraud_type}` +
        (unendorsed.has(c.fraud_type)
          ? " (triage did not mark this as fitting; score it on the evidence below, not on that verdict)"
          : "") +
        `\n    supporting:\n${describe(c.supporting)}\n` +
        `    contradicting:\n${describe(c.contradicting)}`,
    )
    .join("\n\n");
}

/**
 * Run the assessor as two focused calls — classify, then calibrate — falling
 * back to the original single call if triage does not come back usable.
 *
 * Asking a 7B model to choose patterns, attribute evidence and calibrate in
 * one reply produced all three badly at once: it copied the prompt example's
 * pattern and probability, and hedged at mid-range. Splitting the judgement
 * costs one extra call per round and keeps each step a single kind of task.
 */
export async function assess(options: AssessOptions): Promise<AssessOutput> {
  const twoStage = (options.stages ?? 1) === 2;
  // Single-stage skips the triage call entirely rather than running it and
  // ignoring it: one fewer LLM round-trip per assessment, and no path by which
  // a triage verdict can shape the brief.
  const triage = twoStage
    ? await structuredCall({
        llm: options.llm,
        schema: TriageProposalSchema,
        system: options.triageSystemPrompt ?? options.systemPrompt,
        user: options.contextText,
        jsonSchema: { name: "triage", schema: TRIAGE_JSON_SCHEMA },
        fallback: () => ({ candidates: [] }) as TriageProposal,
      })
    : null;

  const usable =
    triage !== null && !triage.usedFallback && triage.value.candidates.length > 0 ? triage.value : null;
  const structured = await structuredCall({
    llm: options.llm,
    schema: AssessmentProposalSchema,
    system: usable && options.calibrateSystemPrompt ? options.calibrateSystemPrompt : options.systemPrompt,
    user: usable
      ? `${renderTriageForCalibration(usable, options.evidence)}\n\nTrigger: ${JSON.stringify(options.trigger)}`
      : options.contextText,
    jsonSchema: { name: "assessment_proposal", schema: ASSESSMENT_PROPOSAL_JSON_SCHEMA },
    fallback: () => fallbackAssessmentProposal(options.trigger, options.evidence),
  });
  const assessment = finalizeAssessment(structured.value, options.evidence, options.sufficiency);
  return { assessment, structured };
}

export type { Assessment, Hypothesis, Sufficiency, EvidenceCategory };