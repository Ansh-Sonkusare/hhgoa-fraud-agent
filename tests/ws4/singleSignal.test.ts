import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";
import type { Hypothesis } from "../../contracts/src/assessment.js";
import { capSingleSignal, independentFraudSignals } from "../../agent/src/singleSignal.js";
import { PATTERN_SHAPE_PREFIX } from "../../agent/src/evidenceBuilder.js";

function ev(id: string, category: EvidenceItem["category"], weight: number, supports: string[], summary = id): EvidenceItem {
  return { id, category, summary, entities: [], source_tool: "t", weight_hint: weight, supports, contradicts: [], ts: "2016-07-04 04:29:21" };
}

// Shapes taken from iteration 12b's cleared alerts.
const CC_0037 = [
  ev("d1", "policy_match", 0.33, ["card_not_present_new_device"]),
  ev("d2", "policy_match", 0.28, ["card_not_present_fraud"]),
  ev("s1", "txn_behavior", 0.5, ["card_not_present_fraud", "card_not_present_new_device", "card_testing"], `${PATTERN_SHAPE_PREFIX}online`),
  ev("s2", "txn_behavior", 0.5, ["card_not_present_new_device"], `${PATTERN_SHAPE_PREFIX}new device`),
  ev("b1", "txn_behavior", 0.3, []),
  ev("m1", "prior_cases", 0.09, ["legitimate"]),
];
const CC_1660 = [
  ev("r1", "device_identity", 0.6, ["fraud"]),
  ev("p1", "prior_cases", 0.5, ["card_not_present_fraud"]),
  ev("m1", "prior_cases", 0.09, ["fraud"]),
];
const ALL_FRAUD: Hypothesis[] = [
  { fraud_type: "card_not_present_new_device", probability: 0.65, supporting: ["d1"], contradicting: [] },
  { fraud_type: "card_not_present_fraud", probability: 0.35, supporting: ["d2"], contradicting: [] },
  { fraud_type: "legitimate", probability: 0, supporting: ["b1", "m1"], contradicting: [] },
];

describe("independentFraudSignals", () => {
  it("counts categories, not items, and ignores pattern shape and near-zero weights", () => {
    expect(independentFraudSignals(CC_0037)).toEqual(["policy_match"]);
    expect(independentFraudSignals(CC_1660).sort()).toEqual(["device_identity", "prior_cases"]);
  });

  it("counts a cardholder denial as a signal", () => {
    expect(independentFraudSignals([...CC_0037, ev("c1", "customer_response", 0.8, ["fraud"])]).sort()).toEqual([
      "customer_response",
      "policy_match",
    ]);
  });
});

describe("capSingleSignal (R1)", () => {
  it("files a single-signal fraud reading just below the fraud line, keeping the pattern ranking", () => {
    const r = capSingleSignal(ALL_FRAUD, CC_0037, 0.69)!;
    expect(r.from).toBeCloseTo(1, 6);
    expect(r.to).toBeCloseTo(0.69, 5);
    const byType = Object.fromEntries(r.hypotheses.map((h) => [h.fraud_type, h.probability]));
    expect(byType["card_not_present_new_device"]!).toBeGreaterThan(byType["card_not_present_fraud"]!);
    expect(byType["legitimate"]).toBeCloseTo(0.31, 5);
    expect(r.hypotheses.reduce((s, h) => s + h.probability, 0)).toBeCloseTo(1, 6);
  });

  it("leaves a case with two independent signals alone (CC-1660: ring web + prior fraud on the card)", () => {
    expect(capSingleSignal(ALL_FRAUD, CC_1660, 0.69)).toBeNull();
  });

  it("leaves a reading already below the line alone", () => {
    const low: Hypothesis[] = [
      { fraud_type: "card_testing", probability: 0.5, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: 0.5, supporting: [], contradicting: [] },
    ];
    expect(capSingleSignal(low, CC_0037, 0.69)).toBeNull();
  });
});
