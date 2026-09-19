import { describe, expect, it } from "vitest";
import { amountBand } from "../../rag/src/types.js";
import { buildFingerprint, entityOverlapScore, explainOverlap } from "../../rag/src/fingerprint.js";

describe("amountBand", () => {
  const cases: [number, string][] = [
    [0, "under_100"],
    [99.99, "under_100"],
    [100, "100_to_500"],
    [499, "100_to_500"],
    [500, "500_to_1000"],
    [1000, "1000_to_5000"],
    [5000, "over_5000"],
  ];
  for (const [amt, band] of cases) {
    it(`${amt} -> ${band}`, () => expect(amountBand(amt)).toBe(band));
  }
  it("bands on absolute value", () => expect(amountBand(-250)).toBe("100_to_500"));
});

describe("buildFingerprint", () => {
  it("includes identity, cards, amount band, and empty signals by default", () => {
    const f = buildFingerprint({
      pattern: "card_testing",
      customer_id: "C001",
      card_id: "C001-K1",
      connected_card_ids: ["C001-K2"],
      exposure_usd: 120,
      outcome: "confirmed_fraud",
    });
    expect(f.entity_ids).toEqual([
      { type: "Customer", id: "C001" },
      { type: "Card", id: "C001-K1" },
      { type: "Card", id: "C001-K2" },
    ]);
    expect(f.amount_band).toBe("100_to_500");
    expect(f.device_signals).toEqual([]);
    expect(f.address_signals).toEqual([]);
  });

  it("pulls device/address signals from an optional transaction signal", () => {
    const f = buildFingerprint({
      pattern: "card_not_present_new_device",
      customer_id: "C001",
      card_id: "C001-K1",
      connected_card_ids: [],
      exposure_usd: 50,
      outcome: "confirmed_fraud",
      signal: {
        txn_id: "999",
        addr1: "444",
        addr2: "87",
        card_network: "visa",
        card_type: "credit",
        device_profile: "SAMSUNG SM-G935F Build/NRD90M | Android | Chrome | 2220x1080",
        device_is_new: true,
        proxy_flag: "anonymous",
      },
    });
    expect(f.device_signals).toEqual(["SAMSUNG SM-G935F Build/NRD90M | Android | Chrome | 2220x1080"]);
    expect(f.address_signals).toEqual(["444"]);
    expect(f.outcome).toBe("confirmed_fraud");
  });
});

describe("entityOverlapScore", () => {
  const fp = (parts: Partial<ReturnType<typeof buildFingerprint>>, customer = "CX", card = "CX-K9") => {
    const base = buildFingerprint({
      pattern: "none",
      customer_id: customer,
      card_id: card,
      connected_card_ids: [],
      exposure_usd: 10,
      outcome: "cleared",
    });
    return { ...base, ...parts };
  };

  it("scores shared customer and cards", () => {
    const a = fp({}, "C001", "C001-K1");
    const b = buildFingerprint({
      pattern: "none",
      customer_id: "C001",
      card_id: "C001-K1",
      connected_card_ids: [],
      exposure_usd: 10,
      outcome: "cleared",
    });
    const s = entityOverlapScore(a, b);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("scores shared device profile and address", () => {
    const a = fp({ device_signals: ["D1"], address_signals: ["444"] });
    const b = fp({ device_signals: ["D1"], address_signals: ["444"] });
    expect(entityOverlapScore(a, b)).toBeGreaterThan(0.2);
  });

  it("scores same pattern and amount band", () => {
    const a = fp({ pattern: "card_testing" }, "A1", "A1-K1");
    const b = fp({ pattern: "card_testing" }, "B2", "B2-K1");
    expect(entityOverlapScore(a, b)).toBe(0.2); // 0.15 pattern + 0.05 band
  });

  it("returns 0 for unrelated cases", () => {
    const a = fp({ pattern: "none" }, "A1", "A1-K1");
    const b = buildFingerprint({
      pattern: "card_testing",
      customer_id: "B2",
      card_id: "B2-K1",
      connected_card_ids: [],
      exposure_usd: 5000,
      outcome: "confirmed_fraud",
    });
    expect(entityOverlapScore(a, b)).toBe(0);
  });
});

describe("explainOverlap", () => {
  it("lists the shared dimensions in plain language (DoD: overlap explanation)", () => {
    const a = buildFingerprint({
      pattern: "account_takeover",
      customer_id: "C001",
      card_id: "C001-K1",
      connected_card_ids: [],
      exposure_usd: 600,
      outcome: "cleared",
      signal: {
        txn_id: "1", addr1: "444", addr2: "87", card_network: "", card_type: "",
        device_profile: "DP1", device_is_new: false, proxy_flag: null,
      },
    });
    const b = buildFingerprint({
      pattern: "account_takeover",
      customer_id: "C001",
      card_id: "C001-K1",
      connected_card_ids: [],
      exposure_usd: 900,
      outcome: "confirmed_fraud",
      signal: {
        txn_id: "2", addr1: "444", addr2: "87", card_network: "", card_type: "",
        device_profile: "DP1", device_is_new: false, proxy_flag: null,
      },
    });
    const reason = explainOverlap(a, b);
    expect(reason).toContain("same customer (C001)");
    expect(reason).toContain("shared card(s) (C001-K1)");
    expect(reason).toContain("shared device profile");
    expect(reason).toContain("shared billing region");
    expect(reason).toContain("same pattern (account_takeover)");
    expect(reason).toContain("similar exposure band");
  });

  it("explains similarity-narrative-only retrieval", () => {
    const a = buildFingerprint({ pattern: "none", customer_id: "A", card_id: "A-K1", connected_card_ids: [], exposure_usd: 5, outcome: "cleared" });
    const b = buildFingerprint({ pattern: "none", customer_id: "Z", card_id: "Z-K9", connected_card_ids: [], exposure_usd: 5000, outcome: "cleared" });
    expect(explainOverlap(a, b)).toContain("narrative similarity only");
  });
});