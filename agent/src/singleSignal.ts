import type { EvidenceCategory, EvidenceItem, Hypothesis } from "@hhgoa/contracts";
import { isNonDiscriminatingDetector, isPatternShape } from "./evidenceBuilder.js";

/**
 * Policy R1 (docs/DATASET_README.md): "If the case rests on a single signal
 * (including a risk score alone) and your assessed fraud probability is below
 * 0.70, recommend VERIFY_WITH_CUSTOMER or STEP_UP_AUTH before any block.
 * Blocking a legitimate customer on one signal is a policy breach."
 *
 * The local assessor does not respect the premise: on cleared model alert
 * CC-0037 (iteration 12b) it put the whole mass on fraud (p = 1.0, legitimate
 * 0) on the strength of one detector hit weighted 0.33, while citing three
 * items for legitimate -- so the probability never fell below 0.70 and R1
 * never applied. PRD §9.3's rule for the same failure is "LLM proposes;
 * assess.ts enforces": a code guard on evidence diversity. This is that guard
 * for the fraud probability: a case whose fraud reading rests on one
 * independent signal is filed just below the fraud line, which makes it
 * `uncertain` and lets R1's verification run before any block.
 */

/** Items at or below this weight are recorded but vote for nothing (see evidenceBuilder.ts). */
const SIGNAL_MIN_WEIGHT = 0.2;

const FRAUD_LABELS = new Set([
  "fraud",
  "card_testing",
  "card_not_present_fraud",
  "card_not_present_new_device",
  "out_of_region_use",
  "account_takeover",
  "undocumented",
]);

/**
 * The independent signals that the case is fraud: distinct evidence
 * categories holding an item that argues for fraud or a fraud pattern with
 * material weight. Pattern-shape items are left out -- they say which pattern
 * a fraud would be, never that fraud occurred (iteration 12) -- and so are
 * detector tiers measured to fire as often on cleared alerts as on fraud. A cardholder's
 * denial is a signal of its own (category customer_response).
 */
export function independentFraudSignals(evidence: readonly EvidenceItem[]): EvidenceCategory[] {
  const cats = new Set<EvidenceCategory>();
  for (const e of evidence) {
    if (isPatternShape(e)) continue;
    if (isNonDiscriminatingDetector(e)) continue;
    if (e.weight_hint <= SIGNAL_MIN_WEIGHT) continue;
    if (e.supports.some((s) => FRAUD_LABELS.has(s))) cats.add(e.category);
  }
  return [...cats];
}

export interface SingleSignalCap {
  hypotheses: Hypothesis[];
  /** Fraud mass before the cap. */
  from: number;
  to: number;
  signals: EvidenceCategory[];
}

/**
 * Caps the fraud mass at `ceiling` when at most one independent signal backs
 * it, moving the excess to `legitimate`. Returns null when the guard does not
 * apply. Fraud hypotheses keep their relative weights, so the pattern ranking
 * is unchanged.
 */
export function capSingleSignal(
  hypotheses: readonly Hypothesis[],
  evidence: readonly EvidenceItem[],
  ceiling: number,
): SingleSignalCap | null {
  const fraudMass = hypotheses.filter((h) => h.fraud_type !== "legitimate").reduce((s, h) => s + h.probability, 0);
  if (fraudMass <= ceiling) return null;
  const signals = independentFraudSignals(evidence);
  if (signals.length > 1) return null;
  const scale = ceiling / fraudMass;
  const capped = hypotheses.map((h) =>
    h.fraud_type === "legitimate" ? { ...h } : { ...h, probability: Math.round(h.probability * scale * 1e6) / 1e6 },
  );
  const newFraud = capped.filter((h) => h.fraud_type !== "legitimate").reduce((s, h) => s + h.probability, 0);
  const legit = capped.find((h) => h.fraud_type === "legitimate");
  if (legit) legit.probability = Math.max(0, 1 - newFraud);
  else capped.push({ fraud_type: "legitimate", probability: Math.max(0, 1 - newFraud), supporting: [], contradicting: [] });
  return { hypotheses: capped, from: fraudMass, to: newFraud, signals };
}
