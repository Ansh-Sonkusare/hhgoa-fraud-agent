import { describe, it, expect } from "vitest";
import { buildSar, type SarInputFacts } from "../../policy/src/sar.js";
import { SarSchema } from "../../contracts/src/answerFile.js";

const triggeringFacts: SarInputFacts = {
  case_id: "HHG-TEST-4",
  customer_id: "C09101",
  primary_card_id: "C09101-K1",
  connected_card_ids: ["C09102-K1"],
  affected_txns: [
    { txn_id: "9910001", ts: "2016-11-14T09:12:10Z", amount_usd: 2.1, product_cd: "W" },
    { txn_id: "9910002", ts: "2016-11-14T09:24:40Z", amount_usd: 1.75, product_cd: "W" },
    { txn_id: "9910003", ts: "2016-11-14T09:41:05Z", amount_usd: 3.4, product_cd: "W" },
    { txn_id: "9910004", ts: "2016-11-14T09:52:20Z", amount_usd: 259.99, product_cd: "C" },
  ],
  device_profiles: ["SAMSUNG SM-G960F Build/PPR1.180610.011 | Android 9 | chrome mobile 71 | 2960x1440"],
  pattern: "card_testing",
  pattern_description: "",
  reason: "R6: shared device profile links this card-testing episode to card C09102-K1",
  channel_summary: "online, via card C09101-K1",
  fraud_confirmed_or_strongly_suspected: true,
  exposure_usd: 267.24,
  shared_origin_connection: true,
  coordinated_or_undocumented: false,
};

describe("buildSar (README Answer Format Part 2 / Fraud Policy §3a, §7)", () => {
  it("renders a full SAR for a policy-triggering case and validates against SarSchema", () => {
    const sar = buildSar(triggeringFacts);
    expect(sar.file).toBe(true);
    expect(sar.narrative.length).toBeGreaterThan(0);
    // "six to twelve sentences" per README; count terminal periods loosely.
    const sentenceCount = (sar.narrative.match(/\.\s/g) ?? []).length + 1;
    expect(sentenceCount).toBeGreaterThanOrEqual(6);
    expect(sar.subjects).toEqual(
      expect.arrayContaining(["C09101", "C09101-K1", "C09102-K1"]),
    );
    expect(sar.total_amount_usd).toBeCloseTo(267.24, 2);
    expect(sar.activity_dates).toEqual(["2016-11-14", "2016-11-14"]);

    const parsed = SarSchema.safeParse(sar);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("who/what/when/where/how/why are all present in the narrative", () => {
    const sar = buildSar(triggeringFacts);
    expect(sar.narrative).toMatch(/C09101/); // who
    expect(sar.narrative).toMatch(/\$/); // what (amounts)
    expect(sar.narrative).toMatch(/2016-11-14/); // when
    expect(sar.narrative).toMatch(/online/); // where/how
    expect(sar.narrative).toMatch(/reported because/); // why
  });

  it("returns file: false with blanked fields when SAR conditions are not met", () => {
    const sar = buildSar({
      ...triggeringFacts,
      exposure_usd: 50,
      shared_origin_connection: false,
      coordinated_or_undocumented: false,
    });
    expect(sar.file).toBe(false);
    expect(sar.narrative).toBe("");
    expect(sar.subjects).toEqual([]);
    expect(sar.total_amount_usd).toBe(0);
    expect(sar.activity_dates).toEqual([]);
    const parsed = SarSchema.safeParse(sar);
    expect(parsed.success).toBe(true);
  });
});
