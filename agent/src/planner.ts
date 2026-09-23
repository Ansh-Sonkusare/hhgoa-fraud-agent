import type { Assessment, EvidenceRequestType } from "@hhgoa/contracts";
import { legitHypothesis, topFraudHypothesis } from "./assess.js";

/**
 * Value-of-information evidence planner (PRD §9.4: "structured evidence
 * planner"). Given the current assessment, scores each permitted,
 * previously-unrequested evidence request type by how well it separates
 * the hypotheses the decision actually rests on, per unit of friction:
 *
 *   score = discrimination / friction_cost
 *
 * where for:
 *  - customer_validation / step_up_auth → separates the top fraud
 *    hypothesis from the legitimate hypothesis (that is the decision any
 *    enforcement act rests on);
 *  - analyst_info → separates the top fraud hypothesis from the runner-up
 *    fraud hypothesis (if any; else from legitimate).
 *
 * A request that cannot separate the top two (discrimination below
 * `minDiscrimination`) is excluded; if nothing qualifies, `chosen` is null
 * and the machine stops with `no_discriminating_evidence_available`.
 * Among qualifying requests, an order preference applies FIRST — in the
 * verification band (R1 actions VERIFY_WITH_CUSTOMER / STEP_UP_AUTH) the
 * recorded agents asked the customer before pulling analyst data, so
 * customer_validation/step_up_auth beat analyst_info even when the score is
 * lower; otherwise analyst_info leads — and score breaks ties within band.
 * Deterministic — this is the code path used for every benchmark run, so
 * the LLM (if it is used at all) can propose variants without owning the
 * final decision.
 */

export const ALL_EVIDENCE_REQUEST_TYPES: readonly EvidenceRequestType[] = [
  "customer_validation",
  "step_up_auth",
  "analyst_info",
];

export const MIN_FRICTION = 1;
export const MIN_DISCRIMINATION = 0.05;

/**
 * Request-type priority per decision band (fixture-faithful, PRD §9.4). In
 * the round-1 band the intended action is customer-verification style
 * (VERIFY_WITH_CUSTOMER / STEP_UP_AUTH), so the recorded agents asked the
 * customer directly BEFORE pulling analyst data — even though analyst_info
 * scores higher on discrimination/friction alone. Outside that band the
 * analyst matters more, so analyst_info leads.
 */
export const VERIFICATION_BAND_ORDER: readonly EvidenceRequestType[] = [
  "customer_validation",
  "step_up_auth",
  "analyst_info",
];
export const ANALYSIS_BAND_ORDER: readonly EvidenceRequestType[] = [
  "analyst_info",
  "customer_validation",
  "step_up_auth",
];

export type PreferenceBand = "verification" | "analysis";

export interface ScoredRequest {
  type: EvidenceRequestType;
  /** How strongly this request would separate the relevant hypothesis pair (0-1). */
  discrimination: number;
  friction_cost: number;
  /** discrimination / friction_cost. */
  score: number;
  /** The hypothesis pair this request would separate. */
  separates: { a: string; b: string };
  rationale: string;
}

export interface EvidencePlan {
  scored: ScoredRequest[];
  chosen: ScoredRequest | null;
  reason: string;
}

function separation(a: number, b: number): number {
  return 1 - Math.abs(a - b);
}

export function planEvidenceGathering(options: {
  assessment: Assessment;
  frictionCosts: Record<EvidenceRequestType, number>;
  /** Only these request types may be made (from the policy config). */
  allowedTypes: readonly EvidenceRequestType[];
  /** Types already requested in earlier rounds — never requested twice. */
  previouslyRequested: readonly EvidenceRequestType[];
  /**
   * Which decision band the intended action is in. Defaults to "analysis";
   * the machine passes "verification" when the intended round-1 action is
   * VERIFY_WITH_CUSTOMER or STEP_UP_AUTH (R1 policy band).
   */
  preferenceBand?: PreferenceBand;
  minDiscrimination?: number;
}): EvidencePlan {
  const available = options.allowedTypes.filter(
    (t) => !options.previouslyRequested.includes(t),
  );
  const topFraud = topFraudHypothesis(options.assessment);
  const legit = legitHypothesis(options.assessment);
  const nonLegit = options.assessment.hypotheses
    .filter((h) => h.fraud_type !== "legitimate")
    .sort((a, b) => b.probability - a.probability);
  const secondFraud = nonLegit[1] ?? null;

  const topProb = topFraud?.probability ?? legit?.probability ?? 0;
  const legitProb = legit?.probability ?? 0;
  const secondProb = secondFraud?.probability ?? legitProb;

  const scored: ScoredRequest[] = [];
  for (const type of available) {
    const friction = options.frictionCosts[type] ?? MIN_FRICTION;
    switch (type) {
      case "customer_validation":
      case "step_up_auth": {
        const d = separation(topProb, legitProb);
        scored.push({
          type,
          discrimination: d,
          friction_cost: friction,
          score: Math.round((d / friction) * 1e4) / 1e4,
          separates: { a: topFraud?.fraud_type ?? "fraud", b: "legitimate" },
          // Name the rule that makes the reply matter: R3 needs a confirmation
          // to close a legitimate reading, R1 needs verification before a block
          // below 0.70, and above that a reply can only settle the case (§6).
          rationale:
            `Separates "${topFraud?.fraud_type ?? "fraud"}" (p=${topProb.toFixed(2)}) from legitimate ` +
            `(p=${legitProb.toFixed(2)}) — ${
              1 - legitProb <= 0.4
                ? "R3 closes a legitimate reading only on the cardholder's confirmation"
                : 1 - legitProb < 0.7
                  ? "R1 asks for this verification before any block below 0.70"
                  : "a reply would settle the question (README §6)"
            }.`,
        });
        break;
      }
      case "analyst_info": {
        const d = separation(topProb, secondProb);
        scored.push({
          type,
          discrimination: d,
          friction_cost: friction,
          score: Math.round((d / friction) * 1e4) / 1e4,
          separates: {
            a: topFraud?.fraud_type ?? "fraud",
            b: secondFraud?.fraud_type ?? "legitimate",
          },
          rationale:
            `Separates "${topFraud?.fraud_type ?? "fraud"}" (p=${topProb.toFixed(2)}) from ` +
            `"${secondFraud?.fraud_type ?? "legitimate"}" (p=${secondProb.toFixed(2)}).`,
        });
        break;
      }
    }
  }

  const minDisc = options.minDiscrimination ?? MIN_DISCRIMINATION;
  const bandOrder =
    options.preferenceBand === "verification" ? VERIFICATION_BAND_ORDER : ANALYSIS_BAND_ORDER;
  const winners = scored
    .filter((w) => w.discrimination >= minDisc)
    .sort(
      (a, b) =>
        bandOrder.indexOf(a.type) - bandOrder.indexOf(b.type) ||
        b.score - a.score,
    );
  const chosen = winners[0] ?? null;

  let reason: string;
  if (scored.length === 0) {
    reason = "No permitted evidence request type remains that has not already been requested.";
  } else if (!chosen) {
    reason = "No remaining request separates the top hypotheses above the minimum discrimination threshold.";
  } else {
    reason =
      `Requesting "${chosen.type}" (score ${chosen.score.toFixed(3)} = discrimination ${chosen.discrimination.toFixed(2)} ` +
      `/ friction ${chosen.friction_cost}) under the ${options.preferenceBand ?? "analysis"} preference band.`;
  }

  return { scored, chosen, reason };
}

/** Highest-scoring permissible request type across all candidates. */
export function pickBestEvidenceRequest(plan: EvidencePlan): ScoredRequest | null {
  return plan.chosen;
}