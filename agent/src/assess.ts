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

/** Evidence weighing at/above this is "material" for the contradiction rule. */
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
export function topFraudHypothesis(assessment: Pick<Assessment, "hypotheses">): Hypothesis | null {
  const nonLegit = assessment.hypotheses.filter((h) => h.fraud_type !== "legitimate");
  if (nonLegit.length === 0) return null;
  return [...nonLegit].sort((a, b) => b.probability - a.probability)[0] ?? null;
}

export function legitHypothesis(assessment: Pick<Assessment, "hypotheses">): Hypothesis | null {
  return assessment.hypotheses.find((h) => h.fraud_type === "legitimate") ?? null;
}

function deriveRiskLevel(topProb: number): RiskLevel {
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
  const topFraud = topFraudHypothesis({ hypotheses });
  const topProb = topFraud?.probability ?? 0;
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
  systemPrompt: string;
  contextText: string;
  trigger: Trigger;
  evidence: EvidenceItem[];
  sufficiency: Sufficiency;
}

export interface AssessOutput {
  assessment: Assessment;
  structured: StructuredCallResult<AssessmentProposal>;
}

/** Run the assessor: model proposal → code-finalized Assessment. */
export async function assess(options: AssessOptions): Promise<AssessOutput> {
  const structured = await structuredCall({
    llm: options.llm,
    schema: AssessmentProposalSchema,
    system: options.systemPrompt,
    user: options.contextText,
    fallback: () => fallbackAssessmentProposal(options.trigger, options.evidence),
  });
  const assessment = finalizeAssessment(structured.value, options.evidence, options.sufficiency);
  return { assessment, structured };
}

export type { Assessment, Hypothesis, Sufficiency, EvidenceCategory };