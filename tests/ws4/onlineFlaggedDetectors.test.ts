import { describe, expect, it } from "vitest";
import { buildEvidenceForTool, createEvidenceIdGen, detectorWeight } from "../../agent/src/evidenceBuilder.js";

const AS_OF = "2016-09-10 12:00:00";

const patterns = (flaggedChannel: string | undefined) =>
  buildEvidenceForTool(
    "detect_patterns",
    {
      patterns: [
        { pattern_id: "account_takeover", score: 0.8, evidence: ["t1", "t2"] },
        { pattern_id: "out_of_region_use", score: 0.65, evidence: ["t3"] },
        { pattern_id: "card_not_present_fraud", score: 0.8, evidence: ["t4"] },
      ],
    },
    createEvidenceIdGen(),
    AS_OF,
    "C1",
    "t4",
    flaggedChannel,
  );

describe("card-present detectors on an online flagged charge", () => {
  it("keeps the hit as context rather than a vote for the card-present pattern", () => {
    // CC-3430: flagged charge online (gold card_not_present_fraud), named
    // account_takeover because the whole-card detector outvoted the channel.
    const [ato, oor, cnp] = patterns("online");
    expect(ato?.supports).toEqual([]);
    expect(ato?.weight_hint).toBe(0.2);
    expect(ato?.summary).toMatch(/flagged charge was online/);
    expect(oor?.supports).toEqual([]);
    expect(cnp?.supports).toEqual(["card_not_present_fraud"]);
  });

  it("still votes for the card-present pattern when the flagged charge was card-present", () => {
    const [ato, oor] = patterns("in_person");
    expect(ato?.supports).toEqual(["account_takeover"]);
    // Weighted by the tier's measured held-out precision, not the raw score.
    expect(ato?.weight_hint).toBe(detectorWeight("account_takeover", 0.8));
    expect(ato?.weight_hint).toBeLessThan(0.5);
    expect(oor?.supports).toEqual(["out_of_region_use"]);
  });

  it("votes as before when the flagged channel is unknown", () => {
    const [ato] = patterns(undefined);
    expect(ato?.supports).toEqual(["account_takeover"]);
  });
});

describe("mixed-channel match-flag failures", () => {
  const history = (flaggedChannel: string) =>
    buildEvidenceForTool(
      "get_transaction_history",
      {
        rows: [
          { txn_id: "f", ts: "2016-09-10 11:00:00", amount_usd: 40, product_cd: "W", channel: flaggedChannel, risk_score: 0.9 },
          { txn_id: "a", ts: "2016-09-09 10:00:00", amount_usd: 20, product_cd: "W", channel: "in_person", risk_score: 0.2, addr1: "204.0", m_flags: "F,F,F" },
          { txn_id: "b", ts: "2016-09-08 10:00:00", amount_usd: 25, product_cd: "W", channel: "in_person", risk_score: 0.2, addr1: "204.0", m_flags: "F,F,T" },
          { txn_id: "c", ts: "2016-09-07 10:00:00", amount_usd: 30, product_cd: "C", channel: "online", risk_score: 0.2 },
        ],
      },
      createEvidenceIdGen(),
      AS_OF,
      "C1",
      "f",
    );

  it("does not vote for a card-present pattern when the flagged charge was online", () => {
    const mixed = history("online").find((e) => e.summary.startsWith("Mixed-channel activity"));
    expect(mixed).toBeDefined();
    expect(mixed?.supports).toEqual([]);
  });
});

describe("mixed-channel match-flag failures on a card-present flagged charge", () => {
  it("still votes for a card-present pattern", () => {
    const items = buildEvidenceForTool(
      "get_transaction_history",
      {
        rows: [
          { txn_id: "f", ts: "2016-09-10 11:00:00", amount_usd: 40, product_cd: "W", channel: "in_person", risk_score: 0.9, addr1: "204.0" },
          { txn_id: "a", ts: "2016-09-09 10:00:00", amount_usd: 20, product_cd: "W", channel: "in_person", risk_score: 0.2, addr1: "204.0", m_flags: "F,F,F" },
          { txn_id: "c", ts: "2016-09-07 10:00:00", amount_usd: 30, product_cd: "C", channel: "online", risk_score: 0.2 },
        ],
      },
      createEvidenceIdGen(),
      AS_OF,
      "C1",
      "f",
    );
    const mixed = items.find((e) => e.summary.startsWith("Mixed-channel activity"));
    expect(mixed?.supports.length).toBeGreaterThan(0);
  });
});

// Detector hits are weighted by each tier's measured held-out precision
// (319 closed cases, excluding the backtest sample), not read as the
// probability the detector is right.
describe("detector tier weights", () => {
  it("keeps the sharp card_testing detector above the unreliable card-present tiers", () => {
    expect(detectorWeight("card_testing", 0.9)).toBeGreaterThan(detectorWeight("account_takeover", 0.8));
    expect(detectorWeight("card_testing", 0.9)).toBeGreaterThan(detectorWeight("out_of_region_use", 0.8));
  });

  it("never lets a detector hit outweigh the tier's measured reliability", () => {
    for (const [p, s] of [
      ["account_takeover", 0.8],
      ["out_of_region_use", 0.8],
      ["card_not_present_new_device", 0.65],
      ["card_not_present_fraud", 0.8],
    ] as const) {
      expect(detectorWeight(p, s)).toBeLessThanOrEqual(0.45);
    }
  });

  it("falls back to the prior for an unmeasured tier instead of the raw score", () => {
    expect(detectorWeight("account_takeover", 0.99)).toBe(0.35);
    expect(detectorWeight("some_future_pattern", 0.9)).toBe(0.35);
  });
});
