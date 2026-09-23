import type { EvidenceItem, Hypothesis } from "@hhgoa/contracts";
import { independentFraudSignals } from "./singleSignal.js";

/**
 * Evidence-calibrated fraud probability for a bank-model alert (a `risk_score`
 * trigger).
 *
 * Why: on model alerts the local assessor's probability does not separate the
 * outcomes. Replaying 45 real cleared alerts and 69 confirmed-fraud cases as the
 * alerts they would have been, it put every cleared alert at 0.50 or above and
 * blocked 6 of them, and `fraud_probability` is scored for calibration
 * (DATASET_README, Answer Format). The evidence itself separates them well, so
 * on model alerts the fraud mass is set from the evidence and the assessor's
 * pattern ranking is kept.
 *
 * How it was fitted (docs/decisions.md, 2026-09-23):
 * - Design set: 300 cleared alerts and 305 confirmed-fraud cases replayed as
 *   model alerts (their real disputed transaction and its real risk score;
 *   fraud the bank's model scored below 0.5 would never have alerted and was
 *   skipped), gathered with the agent's own tools and no LLM. None of the 50+50
 *   backtest cases and no case used for any earlier measurement.
 * - Logistic regression on the evidence features below, with signs constrained
 *   so a fraud signal can only raise the probability and a legitimacy signal
 *   can only lower it (the unconstrained fit gave a transaction-behaviour fraud
 *   signal a negative weight, which no explanation could defend). Chosen on
 *   design-set cross-validation before any held-out look: AUC 0.851 vs 0.859
 *   unconstrained. The other candidate features (prior-case, detector,
 *   transaction-behaviour and graph fraud signals; away-from-home region;
 *   prior fraud on the card) were fitted to weight zero and are left out.
 * - Held-out check, fitted on the design set only: 241 cleared alerts and 388
 *   fraud-as-alert cases never used before. AUC 0.909. Predicted vs actual
 *   fraud rate (1:1 weighted): 0.16 vs 0.05, 0.36 vs 0.28, 0.61 vs 0.62,
 *   0.83 vs 0.85, 0.92 vs 0.91.
 * - Prior: the design set was drawn 1:1 by construction. The history holds no
 *   alert population with both outcomes (every closed alert was cleared, every
 *   fraud case a dispute), so there is no measured alert fraud rate to use and
 *   the neutral one is taken. No benchmark answer distribution is involved.
 *
 * What it does not license: closing a case. At the strictest cutoff it still
 * scored 1 of 388 held-out fraud cases below every cleared case it would have
 * closed, so a legitimate reading only earns a verification request (R3 needs
 * the cardholder's confirmation to close; see recommend.ts).
 *
 * Feature tests read the agent's own evidence text (evidenceBuilder.ts) and
 * are the exact tests the model was fitted and validated on; changing that text
 * silently changes this model, which tests/ws4/alertCalibration.test.ts guards.
 */

interface Feature {
  name: string;
  weight: number;
  /** Plain-language reading used in the explanation. */
  reads: string;
  fires: (evidence: readonly EvidenceItem[]) => EvidenceItem | null;
}

const findSummary = (needle: string) => (evidence: readonly EvidenceItem[]) =>
  evidence.find((e) => e.summary.includes(needle)) ?? null;

const OWN_CLEARED_PRECEDENT = /Similar closed case \S+ \(score [\d.]+, cleared\): shared card/;

const INTERCEPT = 1.639;

const FEATURES: readonly Feature[] = [
  {
    name: "flagged_charge_online",
    weight: 1.181,
    reads: "the flagged charge was card-not-present (online)",
    fires: findSummary("the flagged transaction was card-not-present (online)"),
  },
  {
    name: "flagged_charge_new_device",
    weight: -3.346,
    reads: "the flagged charge ran on a device profile new to this account (84% of cleared alerts vs 24% of fraud in the design set)",
    fires: findSummary("the flagged transaction ran on a device profile this account has not been seen on before"),
  },
  {
    name: "no_prior_cases",
    weight: -1.179,
    reads: "no prior fraud or cleared case on this card or customer",
    fires: findSummary("No prior fraud or cleared cases found"),
  },
  {
    name: "device_identity_signal",
    weight: 0.357,
    reads: "a device/identity fraud signal (shared profiles with other cards)",
    fires: (evidence) =>
      independentFraudSignals(evidence).includes("device_identity")
        ? (evidence.find((e) => e.category === "device_identity" && e.supports.length > 0) ?? null)
        : null,
  },
  {
    name: "own_cleared_precedent",
    weight: -0.179,
    reads: "a cleared case on the same card",
    fires: (evidence) => evidence.find((e) => OWN_CLEARED_PRECEDENT.test(e.summary)) ?? null,
  },
  {
    name: "known_device_other_new",
    weight: 0.032,
    reads: "the flagged charge was on a known device while others in the window were new",
    fires: findSummary("ran on a device profile already associated with this account, while"),
  },
  {
    name: "thin_history",
    weight: -0.012,
    reads: "too few prior transactions for an amount baseline",
    fires: findSummary("too few for an amount baseline"),
  },
];

export interface CalibrationTerm {
  feature: string;
  weight: number;
  reads: string;
  evidence_id: string | null;
}

export interface AlertCalibrationScore {
  probability: number;
  terms: CalibrationTerm[];
}

/** The evidence-calibrated fraud probability and the features that produced it. */
export function scoreAlertEvidence(evidence: readonly EvidenceItem[]): AlertCalibrationScore {
  let z = INTERCEPT;
  const terms: CalibrationTerm[] = [];
  for (const f of FEATURES) {
    const hit = f.fires(evidence);
    if (!hit) continue;
    z += f.weight;
    terms.push({ feature: f.name, weight: f.weight, reads: f.reads, evidence_id: hit.id ?? null });
  }
  return { probability: 1 / (1 + Math.exp(-z)), terms };
}

export interface AlertCalibration {
  hypotheses: Hypothesis[];
  from: number;
  to: number;
  terms: CalibrationTerm[];
}

/**
 * Sets the fraud mass to the calibrated probability. Fraud hypotheses keep
 * their relative weights, so the pattern ranking is unchanged; `legitimate`
 * takes the remainder. Returns null when there is no fraud hypothesis to scale
 * (the assessor's own all-legitimate reading is then kept as it is).
 */
export function applyAlertCalibration(
  hypotheses: readonly Hypothesis[],
  evidence: readonly EvidenceItem[],
): AlertCalibration | null {
  const fraudMass = hypotheses.filter((h) => h.fraud_type !== "legitimate").reduce((s, h) => s + h.probability, 0);
  if (fraudMass <= 0) return null;
  const { probability, terms } = scoreAlertEvidence(evidence);
  const to = Math.round(probability * 1e4) / 1e4;
  const scale = to / fraudMass;
  const out = hypotheses.map((h) =>
    h.fraud_type === "legitimate" ? { ...h } : { ...h, probability: Math.round(h.probability * scale * 1e6) / 1e6 },
  );
  const newFraud = out.filter((h) => h.fraud_type !== "legitimate").reduce((s, h) => s + h.probability, 0);
  const legit = out.find((h) => h.fraud_type === "legitimate");
  if (legit) legit.probability = Math.max(0, 1 - newFraud);
  else out.push({ fraud_type: "legitimate", probability: Math.max(0, 1 - newFraud), supporting: [], contradicting: [] });
  return { hypotheses: out, from: fraudMass, to: newFraud, terms };
}
