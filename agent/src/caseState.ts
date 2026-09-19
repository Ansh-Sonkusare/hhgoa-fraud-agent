import type { Assessment, EvidenceItem } from "@hhgoa/contracts";
import { CaseStateForPolicySchema, type CaseStateForPolicy } from "@hhgoa/policy";
import type { InvestigationFacts } from "./investigation.js";
import { distinctEvidenceCategories, topFraudHypothesis } from "./assess.js";

/**
 * Builds the `CaseStateForPolicy` bag the WS5 policy engine validates
 * (`CaseStateForPolicySchema`) — the single source both `recommend.ts`
 * (next best actions) and the registry's policy tools read from. Kept here
 * (agent side) because it derives policy inputs from investigation facts +
 * assessment, which is the agent's job.
 */

export function buildCaseStateForPolicy(
  facts: InvestigationFacts,
  assessment: Assessment,
  evidence: EvidenceItem[],
): CaseStateForPolicy {
  const topFraud = topFraudHypothesis(assessment);
  const fraudProb = topFraud?.probability ?? assessment.legit_hypothesis_probability;
  const categories = distinctEvidenceCategories(evidence);

  const sharedOrigin = facts.rings.some((r) => r.card_ids.length > 1);
  const coordinated = facts.patterns.some(
    (p) => p.pattern_id === "undocumented" || p.pattern_id === "coordinated",
  );
  const stronglySuspected = fraudProb >= 0.7 || facts.customer_denied;

  const cs: CaseStateForPolicy = {
    case_id: facts.case_id,
    fraud_probability: Math.round(fraudProb * 1e6) / 1e6,
    evidence_category_count: categories.length,
    exposure_usd: facts.exposure_usd,
    customer_denied: facts.customer_denied,
    customer_confirmed: facts.customer_confirmed,
    confirmed_fraud_card_count: facts.prior_cases.filter((c) => c.outcome === "confirmed_fraud").length,
    credentials_confirmed_compromised: false,
    shared_origin_connection: sharedOrigin,
    coordinated_or_undocumented: coordinated,
    fraud_confirmed_or_strongly_suspected: stronglySuspected,
  };
  return CaseStateForPolicySchema.parse(cs);
}

export function isLegitVerdict(assessment: Assessment): boolean {
  const topFraud = topFraudHypothesis(assessment);
  return (topFraud?.probability ?? 0) <= 0.4;
}