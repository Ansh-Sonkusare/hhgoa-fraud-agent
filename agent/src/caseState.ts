import type { Assessment, EvidenceItem } from "@hhgoa/contracts";
import { CaseStateForPolicySchema, type CaseStateForPolicy } from "@hhgoa/policy";
import type { InvestigationFacts } from "./investigation.js";
import { assessSharedOrigin } from "./sharedOrigin.js";
import { distinctEvidenceCategories, fraudProbability } from "./assess.js";

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
  // Same number the verdict uses. The old `topFraud?.probability ??
  // legit_hypothesis_probability` both split the fraud mass across patterns
  // and, with no fraud hypothesis, fed the *legitimate* probability to the
  // policy engine as the fraud probability.
  const fraudProb = fraudProbability(assessment);
  const categories = distinctEvidenceCategories(evidence);

  // Not "shares any attribute with another card" — a corroborated shared
  // origin only (see sharedOrigin.ts): a plausible ring plus either prior
  // confirmed fraud or a fraud-concentrated community. Otherwise a coarse
  // fingerprint collision would force a SAR.
  const sharedOrigin = assessSharedOrigin(facts).shared_origin_connection;
  // R9: a detector naming an undocumented/coordinated pattern, or the flagged
  // charge's device being the cross-card anonymous-proxy ring -- the graph
  // finding that names `undocumented` (evidenceBuilder.readProxyDeviceRing).
  const coordinated =
    Boolean(facts.proxy_device_ring) ||
    facts.patterns.some((p) => p.pattern_id === "undocumented" || p.pattern_id === "coordinated");
  const stronglySuspected = fraudProb >= 0.7 || facts.customer_denied;

  const cs: CaseStateForPolicy = {
    case_id: facts.case_id,
    fraud_probability: Math.round(fraudProb * 1e6) / 1e6,
    evidence_category_count: categories.length,
    exposure_usd: facts.exposure_usd,
    customer_denied: facts.customer_denied,
    customer_confirmed: facts.customer_confirmed,
    verification_unanswered: facts.verification_unanswered,
    // R10 counts the customer's CARDS with confirmed fraud, not their prior
    // cases. find_prior_cases is scoped to the primary card
    // (investigation.ts), so every case it returns belongs to that one card,
    // and PriorCaseRef carries no card_id to distinguish others. Counting
    // cases let a single card with three historical frauds trip R10 and
    // recommend BLOCK_ALL_CARDS on every fraud verdict — the over-blocking
    // the README warns scores badly. We can only ever evidence one card from
    // this source, so that is what we claim.
    confirmed_fraud_card_count: facts.prior_cases.some((c) => c.outcome === "confirmed_fraud") ? 1 : 0,
    credentials_confirmed_compromised: false,
    shared_origin_connection: sharedOrigin,
    coordinated_or_undocumented: coordinated,
    fraud_confirmed_or_strongly_suspected: stronglySuspected,
  };
  return CaseStateForPolicySchema.parse(cs);
}

export function isLegitVerdict(assessment: Assessment): boolean {
  return fraudProbability(assessment) <= 0.4;
}