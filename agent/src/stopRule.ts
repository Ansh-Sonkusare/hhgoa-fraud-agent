import type { Assessment, EvidenceCategory, NextBestAction } from "@hhgoa/contracts";
import { legitHypothesis, topFraudHypothesis } from "./assess.js";

/**
 * Stop rule (PRD §9.5). Decides, after each assessment, whether the current
 * reason/evidence base is enough to move to DECIDING, and if not why not.
 *
 * The PRD conditions (ALL must hold to stop as SUFFICIENT):
 *   1. ≥3 independent evidence categories consulted, OR all available
 *      categories are exhausted;
 *   2. top hypothesis leads runner-up by ≥0.25 points, OR confidence ≥0.75;
 *   3. the intended action's policy prerequisites are satisfied
 *      (`policy_check` allowed).
 *
 * Stop reasons: sufficient_evidence | budget_exhausted |
 * no_discriminating_evidence_available | policy_requires_human.
 */
export type StopReason =
  | "sufficient_evidence"
  | "budget_exhausted"
  | "no_discriminating_evidence_available"
  | "policy_requires_human";

export const STOP_REASONS: readonly StopReason[] = [
  "sufficient_evidence",
  "budget_exhausted",
  "no_discriminating_evidence_available",
  "policy_requires_human",
];

export const MIN_CATEGORY_COUNT = 3;
export const MIN_PROBABILITY_LEAD = 0.25;
export const MIN_CONFIDENCE = 0.75;

export interface StopRuleInput {
  assessment: Assessment;
  /** Distinct evidence categories consulted so far. */
  categories: EvidenceCategory[];
  /** True when no *new* independent category could be gathered anymore. */
  allCategoriesExhausted: boolean;
  /** The action the agent would take next (highest-priority recommendation). */
  intendedAction: NextBestAction | null;
  /** policy_check(intendedAction).allowed */
  intendedActionAllowed: boolean;
  /** Investigation tool budget exhausted (MAX_TOOL_CALLS). */
  budgetExhausted: boolean;
  /** No permitted, previously-unrequested evidence could change the decision. */
  noDiscriminatingEvidence: boolean;
  /** Customer already denied the triggering transaction (wording only). */
  customerDenied?: boolean;
}

export interface StopRuleDecision {
  stop: boolean;
  reason: StopReason | null;
}

function topTwo(assessment: Assessment): Array<{ fraud_type: string; probability: number }> {
  const sorted = [...assessment.hypotheses].sort((a, b) => b.probability - a.probability);
  return sorted.slice(0, 2);
}

/** |top - runner-up| probability lead. */
export function probabilityLead(assessment: Assessment): number {
  const [top, runner] = topTwo(assessment);
  if (!top) return 0;
  return Math.abs(top.probability - (runner?.probability ?? 0));
}

export function categoriesOk(categories: EvidenceCategory[], allExhausted: boolean): boolean {
  return categories.length >= MIN_CATEGORY_COUNT || allExhausted;
}

export function confidenceOk(assessment: Assessment): boolean {
  return (
    assessment.confidence >= MIN_CONFIDENCE || probabilityLead(assessment) >= MIN_PROBABILITY_LEAD
  );
}

export function evaluateStop(input: StopRuleInput): StopRuleDecision {
  if (input.budgetExhausted) {
    return { stop: true, reason: "budget_exhausted" };
  }

  const catOk = categoriesOk(input.categories, input.allCategoriesExhausted);
  const confOk = confidenceOk(input.assessment);

  if (catOk && confOk && input.intendedActionAllowed) {
    return { stop: true, reason: "sufficient_evidence" };
  }

  if (!catOk && input.noDiscriminatingEvidence) {
    return { stop: true, reason: "no_discriminating_evidence_available" };
  }

  // Confidence and categories are fine but the intended action's
  // prerequisites can't be satisfied by more evidence and it needs a human.
  if (catOk && confOk && !input.intendedActionAllowed && input.noDiscriminatingEvidence) {
    const route = input.intendedAction?.route;
    if (route === "L1" || route === "L2") {
      return { stop: true, reason: "policy_requires_human" };
    }
  }

  if (input.noDiscriminatingEvidence) {
    return { stop: true, reason: "no_discriminating_evidence_available" };
  }

  return { stop: false, reason: null };
}

const NUMBER_WORDS: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
};

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function formatCategories(categories: EvidenceCategory[]): string {
  return categories.length ? `(${categories.join(", ")})` : "";
}

/** Human-readable description of why the rule is (not) satisfied. */
export function describeEvaluateStop(
  input: StopRuleInput,
  decision: StopRuleDecision,
): string {
  const top = topFraudHypothesis(input.assessment);
  const legit = legitHypothesis(input.assessment);
  const lead = probabilityLead(input.assessment);
  const cats = input.categories.length;
  if (decision.reason === "sufficient_evidence") {
    if (input.customerDenied) {
      return "Customer denial settled the verdict; further steps would not change the block decision.";
    }
    return (
      `Fraud probability ${top?.probability.toFixed(2)} with ${numberWord(cats)} independent evidence ` +
      `categories ${formatCategories(input.categories)} clears the ${MIN_CONFIDENCE} confidence threshold; ` +
      `further investigation would not change the decision.`
    );
  }
  if (decision.reason === "budget_exhausted") {
    return "Investigation tool budget exhausted; stopping to avoid runaway tool calls (PRD §9.5).";
  }
  if (decision.reason === "no_discriminating_evidence_available") {
    return (
      `Only ${numberWord(cats)} independent evidence categories available and no permitted request can separate ` +
      `"${top?.fraud_type ?? "?"}" from "${legit?.fraud_type ?? "legitimate"}" (margin ${lead.toFixed(2)}).`
    );
  }
  if (decision.reason === "policy_requires_human") {
    return (
      `Confidence and category conditions are met but ${input.intendedAction?.action ?? "the intended action"} ` +
      `requires human sign-off (${input.intendedAction?.route}); routing to an analyst.`
    );
  }
  return `Not stopping yet: categories=${cats} (need ≥${MIN_CATEGORY_COUNT} or exhausted), ` +
    `lead=${lead.toFixed(2)} (need ≥${MIN_PROBABILITY_LEAD} or confidence ≥${MIN_CONFIDENCE}).`;
}