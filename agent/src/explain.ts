import type { Assessment, EvidenceItem } from "@hhgoa/contracts";
import type { InvestigationFacts } from "./investigation.js";
import { topFraudHypothesis, legitHypothesis, fraudProbability } from "./assess.js";
import type { Recommendations } from "./recommend.js";
import type { StopReason } from "./stopRule.js";

/**
 * Explainer (PRD §9.3 "answers the question why ..."). Deterministic:
 * surfaces exactly the evidence the decision used, why more evidence was
 * (not) needed, why each recommended action appears, and — critically —
 * what *would* have changed the decision. All strings derived from the
 * run's own facts/assessment/recommendation; nothing invented.
 */

export interface Explanation {
  evidence_used: string[];
  why_more_evidence: string | null;
  why_actions: Record<string, string>;
  remaining_uncertainty: string;
  what_would_change_the_decision: string;
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

export function buildExplanation(options: {
  facts: InvestigationFacts;
  assessment: Assessment;
  evidence: EvidenceItem[];
  recommendations: Recommendations;
  evidenceRequests: Array<{ type: string; assumed_response: string }>;
  stopReason: StopReason | null;
}): Explanation {
  const { facts, assessment, evidence, recommendations, stopReason } = options;

  const topFraud = topFraudHypothesis(assessment);
  const legit = legitHypothesis(assessment);
  const topProb = fraudProbability(assessment);
  const legitProb = legit?.probability ?? 0;

  const evidence_used = evidence.map((e) => `${e.id}: ${truncate(e.summary, 160)}`);

  let why_more_evidence: string | null = null;
  const firstRequest = options.evidenceRequests[0];
  if (firstRequest) {
    why_more_evidence =
      `R1: probability ${topProb.toFixed(2)} on a weak/ambiguous signal was below the ` +
      `0.70 block threshold, so "${firstRequest.type}" was requested before any enforcement ` +
      `(no reply is available -- the dataset supplies none and none was assumed: ` +
      `${truncate(firstRequest.assumed_response, 120)}).`;
  } else if (stopReason && stopReason !== "sufficient_evidence") {
    why_more_evidence = `Investigation stopped with reason "${stopReason}"`;
  }

  const why_actions: Record<string, string> = {};
  for (const a of recommendations.actions) {
    const r = recommendations.why[a.action];
    if (r) why_actions[a.action] = r;
  }

  const topName = topFraud?.fraud_type ?? "legitimate";
  const remaining_uncertainty =
    `Top hypothesis "${topName}" at ${topProb.toFixed(2)} versus legitimate at ` +
    `${legitProb.toFixed(2)}; model confidence ${assessment.confidence.toFixed(2)}. ` +
    `Uncertainty is driven by ${facts.similar_cases.length > 0 ? `a similar closed case (${facts.similar_cases.map((c) => `${c.case_id}@${c.score.toFixed(2)}`).join(", ")})` : "the evidence set itself"}.`;

  let what_would_change_the_decision: string;
  if (facts.customer_confirmed) {
    what_would_change_the_decision =
      `If the customer had instead denied the purchase, R2 would apply and the ` +
      `case would escalate to a block; a confirmation clears it (R3).`;
  } else if (facts.dispute_recurring) {
    what_would_change_the_decision =
      `The dispute repeats this card's own monthly charge, so R7 recommends ` +
      `verification without a block; if the customer does not recognise the ` +
      `recurring charge either, R2 would apply and the card would be blocked.`;
  } else if (facts.customer_denied && facts.trigger.kind === "customer_report") {
    what_would_change_the_decision =
      `The cardholder disputed the charge, so R2 applies. A match to their own ` +
      `monthly recurring charge (R7) would have downgraded this to verification ` +
      `without a block; no such recurring charge was established.`;
  } else if (facts.customer_denied) {
    what_would_change_the_decision =
      `If the customer had instead confirmed the purchase, R3 would apply and the ` +
      `case would close as legitimate.`;
  } else if (assessment.confidence < 0.75) {
    what_would_change_the_decision =
      `Evidence that raises confidence above ${0.75} (e.g. a customer confirmation or ` +
      `step-up authentication) would let the recommender act without further verification.`;
  } else {
    what_would_change_the_decision =
      `Evidence that the cardholder made these purchases (e.g. a customer confirmation) ` +
      `would clear the case; none is expected given the pattern strength.`;
  }

  return {
    evidence_used,
    why_more_evidence,
    why_actions,
    remaining_uncertainty,
    what_would_change_the_decision,
  };
}