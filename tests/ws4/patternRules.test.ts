import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";
import type { Hypothesis } from "../../contracts/src/assessment.js";
import { applyChannelRule, applyNewDeviceRule } from "../../agent/src/patternRules.js";
import { PATTERN_SHAPE_PREFIX } from "../../agent/src/evidenceBuilder.js";

function ev(id: string, summary: string, supports: string[], contradicts: string[] = []): EvidenceItem {
  return { id, category: "txn_behavior", summary, entities: [], source_tool: "get_transaction_history", weight_hint: 0.5, supports, contradicts, ts: "2016-10-23 18:11:37" };
}

const NEW_DEVICE = ev("ev_003", `${PATTERN_SHAPE_PREFIX}the flagged transaction ran on a device profile this account has not been seen on before`, ["card_not_present_new_device"], ["card_not_present_fraud"]);
const KNOWN_DEVICE = ev("ev_003", `${PATTERN_SHAPE_PREFIX}the flagged transaction ran on a device profile already associated with this account`, [], ["card_not_present_new_device"]);
// CC-5194, iteration 13: the assessor cited the new-device item and still named plain CNP.
const CC_5194: Hypothesis[] = [
  { fraud_type: "card_not_present_fraud", probability: 0.65, supporting: ["ev_002", "ev_005"], contradicting: [] },
  { fraud_type: "card_not_present_new_device", probability: 0.3, supporting: ["ev_003"], contradicting: [] },
  { fraud_type: "legitimate", probability: 0.05, supporting: ["ev_007"], contradicting: [] },
];

describe("applyNewDeviceRule (README pattern 3)", () => {
  it("names the new-device pattern when the flagged charge is on a New device", () => {
    const r = applyNewDeviceRule(CC_5194, [NEW_DEVICE])!;
    const by = Object.fromEntries(r.hypotheses.map((h) => [h.fraud_type, h.probability]));
    expect(by["card_not_present_fraud"]).toBeUndefined();
    expect(by["card_not_present_new_device"]).toBeCloseTo(0.95, 6);
    expect(by["legitimate"]).toBeCloseTo(0.05, 6);
    expect(r.hypotheses.find((h) => h.fraud_type === "card_not_present_new_device")!.supporting).toContain("ev_003");
  });

  it("creates the new-device hypothesis when the assessor did not list it", () => {
    const r = applyNewDeviceRule([CC_5194[0]!, CC_5194[2]!], [NEW_DEVICE])!;
    expect(r.hypotheses.map((h) => h.fraud_type).sort()).toEqual(["card_not_present_new_device", "legitimate"]);
  });

  it("leaves a known-device case, and non-CNP patterns, alone", () => {
    expect(applyNewDeviceRule(CC_5194, [KNOWN_DEVICE])).toBeNull();
    const ato: Hypothesis[] = [
      { fraud_type: "account_takeover", probability: 0.8, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: 0.2, supporting: [], contradicting: [] },
    ];
    expect(applyNewDeviceRule(ato, [NEW_DEVICE])).toBeNull();
  });
});

const ONLINE = ev("ev_002", `${PATTERN_SHAPE_PREFIX}the flagged transaction was card-not-present (online)`, ["card_not_present_fraud", "card_not_present_new_device", "card_testing"], ["out_of_region_use", "account_takeover"]);
// CC-5194, iteration 18: the pattern scorer named account takeover on an online, New-device charge.
const ATO_ONLINE: Hypothesis[] = [
  { fraud_type: "account_takeover", probability: 0.47, supporting: ["ev_009"], contradicting: [] },
  { fraud_type: "card_not_present_new_device", probability: 0.33, supporting: ["ev_003"], contradicting: [] },
  { fraud_type: "card_not_present_fraud", probability: 0.1, supporting: [], contradicting: [] },
  { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: [] },
];

describe("applyChannelRule (online flagged charge rules out card-present patterns)", () => {
  it("moves a card-present top pattern to the strongest card-not-present reading", () => {
    const r = applyChannelRule(ATO_ONLINE, [ONLINE])!;
    const by = Object.fromEntries(r.hypotheses.map((h) => [h.fraud_type, h.probability]));
    expect(by["account_takeover"]).toBeUndefined();
    expect(by["card_not_present_new_device"]).toBeCloseTo(0.8, 6);
    expect(by["card_not_present_fraud"]).toBeCloseTo(0.1, 6);
    expect(by["legitimate"]).toBeCloseTo(0.1, 6);
    expect(r.from).toBe("account_takeover");
    expect(r.to).toBe("card_not_present_new_device");
    // The fraud total, and so the verdict, is unchanged.
    const fraud = r.hypotheses.filter((h) => h.fraud_type !== "legitimate").reduce((s, h) => s + h.probability, 0);
    expect(fraud).toBeCloseTo(0.9, 6);
  });

  it("falls back to card_not_present_fraud when no card-not-present reading has mass", () => {
    const r = applyChannelRule(
      [
        { fraud_type: "out_of_region_use", probability: 0.9, supporting: [], contradicting: [] },
        { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: [] },
      ],
      [ONLINE],
    )!;
    expect(r.to).toBe("card_not_present_fraud");
    expect(r.hypotheses.find((h) => h.fraud_type === "card_not_present_fraud")!.probability).toBeCloseTo(0.9, 6);
  });

  it("does nothing on a card-present flagged charge, or when a CNP pattern already leads", () => {
    expect(applyChannelRule(ATO_ONLINE, [KNOWN_DEVICE])).toBeNull();
    expect(applyChannelRule(CC_5194, [ONLINE])).toBeNull();
  });

  it("then lets the new-device rule name pattern 3", () => {
    const moved = applyChannelRule(
      [
        { fraud_type: "account_takeover", probability: 0.8, supporting: [], contradicting: [] },
        { fraud_type: "legitimate", probability: 0.2, supporting: [], contradicting: [] },
      ],
      [ONLINE, NEW_DEVICE],
    )!;
    const r = applyNewDeviceRule(moved.hypotheses, [ONLINE, NEW_DEVICE])!;
    expect(r.hypotheses.find((h) => h.fraud_type === "card_not_present_new_device")!.probability).toBeCloseTo(0.8, 6);
  });
});

describe("new-device rule on an in-episode new device", () => {
  it("also fires on the within-30-minutes episode item", () => {
    const EPISODE = ev("ev_004", `${PATTERN_SHAPE_PREFIX}the flagged transaction ran on a device profile already associated with this account, but 1 other online transaction(s) within 30 minutes of it ran on a device profile this account has not been seen on before`, ["card_not_present_new_device"], ["card_not_present_fraud"]);
    const r = applyNewDeviceRule(CC_5194, [EPISODE])!;
    expect(r.item).toBe("ev_004");
    expect(r.hypotheses.find((h) => h.fraud_type === "card_not_present_new_device")!.probability).toBeCloseTo(0.95, 6);
  });
});
