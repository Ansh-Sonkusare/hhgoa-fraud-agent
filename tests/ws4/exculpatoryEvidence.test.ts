import { describe, it, expect } from "vitest";
import { buildEvidenceForTool, createEvidenceIdGen } from "../../agent/src/evidenceBuilder.js";

/**
 * Evidence that argues FOR the cardholder.
 *
 * Until 2026-09-22 only two items in the whole builder ever supported
 * `legitimate` ("no shared rings", 0.2; "only cleared prior cases", 0.1).
 * Velocity supported "fraud" at any count, a silent detector run said nothing,
 * the channel claim supported a fraud family on channel alone, and a device the
 * account had already used supported card_not_present_fraud. Triage's rule is
 * "never invent support", so a clean card's brief left `legitimate` with
 * nothing to cite and every cleared case in the 20-case backtest escalated
 * (3 of 3). These tests pin the data-true encodings.
 */

const AS_OF = "2016-11-12T00:35:00Z";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txn_id: "T1",
    ts: "2016-11-11T10:00:00Z",
    amount_usd: 40,
    product_cd: "W",
    channel: "online",
    risk_score: 0.1,
    addr1: "204",
    id_15: "Found",
    id_23: "",
    m_flags: "TTTTTTTTT",
    ...over,
  };
}

function history(rows: Record<string, unknown>[], flaggedTxnId = "T1") {
  return buildEvidenceForTool(
    "get_transaction_history",
    { rows, stats: { count: rows.length, total_amount_usd: 0, window: "168h" } },
    createEvidenceIdGen(),
    AS_OF,
    undefined,
    flaggedTxnId,
  );
}

describe("detect_patterns with nothing fired", () => {
  // A miss is recorded, but it votes for nothing: on 319 held-out closed cases
  // no detector fires on 32% of cleared cases and 48% of card-not-present
  // fraud, so it is not exculpatory.
  it("states that none of the five documented patterns matched, without voting", () => {
    const items = buildEvidenceForTool("detect_patterns", { patterns: [] }, createEvidenceIdGen(), AS_OF);
    expect(items).toHaveLength(1);
    const none = items[0]!;
    expect(none.category).toBe("policy_match");
    expect(none.source_tool).toBe("detect_patterns");
    expect(none.supports).toEqual([]);
    expect(none.contradicts).toEqual([]);
    expect(none.weight_hint).toBeLessThanOrEqual(0.2);
    for (const p of [
      "card_testing",
      "card_not_present_fraud",
      "card_not_present_new_device",
      "out_of_region_use",
      "account_takeover",
    ]) {
      expect(none.summary).toContain(p);
    }
  });

  it("still emits nothing when the tool returned no payload at all", () => {
    // No payload is a failed call, not a clean bill of health.
    expect(buildEvidenceForTool("detect_patterns", null, createEvidenceIdGen(), AS_OF)).toEqual([]);
  });

  it("names the pattern when one did fire", () => {
    const items = buildEvidenceForTool(
      "detect_patterns",
      { patterns: [{ pattern_id: "account_takeover", score: 0.8, evidence: ["T9"] }] },
      createEvidenceIdGen(),
      AS_OF,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.supports).toEqual(["account_takeover"]);
  });
});

describe("shared-entity rings", () => {
  const rings = (r: Array<{ shared_type: string; shared_id: string; card_ids: string[] }>) =>
    buildEvidenceForTool("find_shared_entity_rings", { rings: r }, createEvidenceIdGen(), AS_OF, "C1");

  it("treats a shared email domain as a provider, not a person", () => {
    // The dataset only carries email domains (docs/DATASET_README.md line 75), so
    // an email ring is "these cards use yahoo.com.mx", which supports nothing.
    const [item] = rings([{ shared_type: "email", shared_id: "yahoo.com.mx", card_ids: ["C1", "C2", "C3"] }]);
    expect(item?.supports).toEqual([]);
    expect(item?.contradicts).toEqual([]);
    expect(item?.weight_hint).toBe(0.2);
    expect(item?.summary).toMatch(/shared domain, not a shared address/);
    expect(item?.summary).toContain("C2, C3");
  });

  it("reads one or two shared profiles as household overlap, not fraud", () => {
    // Measured: 1-2 specific shared profiles on 47% of cleared cases vs 10% of
    // confirmed fraud. Each ring is context; one aggregate item carries weight.
    const items = rings([
      { shared_type: "device", shared_id: "7c503fd7", card_ids: ["C1", "C2"] },
      { shared_type: "address", shared_id: "204.0", card_ids: ["C1", "C3"] },
    ]);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.supports.length === 0)).toBe(true);
    const aggregate = items[2];
    expect(aggregate?.summary).toMatch(/household or a common device/);
    expect(aggregate?.weight_hint).toBe(0.2);
  });

  it("counts a web of shared profiles once, as fraud evidence", () => {
    // Three or more on 67% of confirmed fraud vs 20% of cleared. The fact is
    // voted once: the per-ring items stay as context, not one vote each.
    const items = rings([
      { shared_type: "device", shared_id: "d1", card_ids: ["C1", "C2"] },
      { shared_type: "device", shared_id: "d2", card_ids: ["C1", "C3", "C4"] },
      { shared_type: "address", shared_id: "204.0", card_ids: ["C1", "C2"] },
      { shared_type: "email", shared_id: "gmail.com", card_ids: ["C1", "C9"] },
    ]);
    const voting = items.filter((i) => i.supports.includes("fraud"));
    expect(voting).toHaveLength(1);
    expect(voting[0]?.weight_hint).toBe(0.6);
    expect(voting[0]?.summary).toContain("3 device profiles / billing regions with 3 other card(s)");
    // The email ring is itemised but excluded from the count (a provider, not a person).
    expect(voting[0]?.entities.map((e) => e.id)).not.toContain("C9");
  });

  it("leaves crowd fingerprints out of the count", () => {
    const crowd = Array.from({ length: 30 }, (_, i) => `K${i}`);
    const items = rings([
      { shared_type: "device", shared_id: "crowd", card_ids: ["C1", ...crowd] },
      { shared_type: "device", shared_id: "d1", card_ids: ["C1", "C2"] },
    ]);
    expect(items.some((i) => i.supports.includes("fraud"))).toBe(false);
  });
});

describe("velocity is context, not a verdict", () => {
  it("carries no supports either way", () => {
    const items = buildEvidenceForTool(
      "compute_velocity",
      { count: 3, window_minutes: 1440, total_amount_usd: 120 },
      createEvidenceIdGen(),
      AS_OF,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.supports).toEqual([]);
    expect(items[0]?.contradicts).toEqual([]);
    expect(items[0]?.summary).toContain("3 transaction(s)");
  });
});

describe("baseline deviation reads the way it votes", () => {
  it("describes an in-range charge as within the usual range and contradicts fraud", () => {
    const items = buildEvidenceForTool(
      "get_baseline_deviation",
      { amount_z: 0.4, geo_z: 0, device_z: 0.1, time_z: 0 },
      createEvidenceIdGen(),
      AS_OF,
    );
    expect(items[0]?.summary).toMatch(/within the cardholder's usual amount range/);
    expect(items[0]?.summary).not.toMatch(/deviates/);
    expect(items[0]?.contradicts).toEqual(["fraud"]);
  });

  it("describes a real deviation as one and supports fraud", () => {
    const items = buildEvidenceForTool(
      "get_baseline_deviation",
      { amount_z: 3.2, geo_z: 0, device_z: 0.1, time_z: 0 },
      createEvidenceIdGen(),
      AS_OF,
    );
    expect(items[0]?.summary).toMatch(/deviates from cardholder baseline/);
    expect(items[0]?.supports).toEqual(["fraud"]);
  });
});

describe("the channel claim names the family and rules out the other", () => {
  // Not a vote for fraud; the classification signal that decides which
  // pattern is possible. Measured: with the family named, 47.1% pattern exact
  // and 0/17 false negatives; with supports emptied, 29.4% and 4/17, and
  // cleared-case escalation 3/3 either way. Weight 0.5 -- below the 0.6-0.85
  // the actual pattern detectors carry, so it steers the family without
  // outweighing real signal.
  it("online: supports the card-not-present family and contradicts out_of_region_use", () => {
    const structural = history([row({ channel: "online" })]).find((i) =>
      i.summary.includes("card-not-present (online)"),
    );
    expect(structural).toBeDefined();
    expect(structural?.supports).toEqual(
      expect.arrayContaining(["card_not_present_fraud", "card_not_present_new_device", "card_testing"]),
    );
    expect(structural?.supports).not.toContain("legitimate");
    expect(structural?.contradicts).toContain("out_of_region_use");
    expect(structural?.weight_hint).toBeLessThan(0.6);
  });

  it("in person: supports the card-present family and contradicts the card-not-present family", () => {
    const structural = history([row({ channel: "in_person" })]).find((i) => i.summary.includes("card-present (in person)"));
    expect(structural).toBeDefined();
    expect(structural?.supports).toEqual(expect.arrayContaining(["out_of_region_use", "account_takeover"]));
    expect(structural?.contradicts).toEqual(
      expect.arrayContaining(["card_not_present_fraud", "card_not_present_new_device", "card_testing"]),
    );
    expect(structural?.weight_hint).toBeLessThan(0.6);
  });
});

describe("card-present regions", () => {
  const home = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) =>
      row({ txn_id: `H${i}`, channel: "in_person", addr1: "204", ts: `2016-11-0${(i % 8) + 1}T10:00:00Z`, ...over }),
    );

  it("says the flagged charge is in the card's home region when it is", () => {
    const rows = [
      ...home(5),
      row({ txn_id: "A1", channel: "in_person", addr1: "330", ts: "2016-11-10T10:00:00Z" }),
      row({ txn_id: "T1", channel: "in_person", addr1: "204", ts: "2016-11-11T10:00:00Z" }),
    ];
    const item = history(rows, "T1").find((i) => i.summary.includes("the region this card is used in most"));
    expect(item).toBeDefined();
    // Neutral on misuse: in the closed history this fires on 40% of
    // account_takeover cases against 3% of cleared ones, so it must not argue
    // for `legitimate`. It only rules out out_of_region_use.
    expect(item?.supports).toEqual([]);
    expect(item?.contradicts).toEqual(["out_of_region_use"]);
    expect(item?.summary).toContain("region 204");
  });

  it("does not argue for out_of_region_use when the flagged charge is in the home region", () => {
    // The typical account_takeover shape: the card has some away activity in
    // the window, but the flagged charge itself is at home.
    const rows = [
      ...home(5),
      row({ txn_id: "A1", channel: "in_person", addr1: "330", ts: "2016-11-10T10:00:00Z" }),
      row({ txn_id: "T1", channel: "in_person", addr1: "204", ts: "2016-11-11T10:00:00Z" }),
    ];
    // The channel claim still names both card-present patterns; what must not
    // happen is a region item arguing for out_of_region_use.
    const regionItems = history(rows, "T1").filter((i) => /billing region/.test(i.summary));
    expect(regionItems.some((i) => i.supports.includes("out_of_region_use"))).toBe(false);
  });

  it("does not argue for out_of_region_use when the flagged charge is online", () => {
    const rows = [
      ...home(5),
      row({ txn_id: "A1", channel: "in_person", addr1: "330", ts: "2016-11-10T10:00:00Z" }),
      row({ txn_id: "T1", channel: "online", addr1: "", ts: "2016-11-11T10:00:00Z" }),
    ];
    // The channel claim still names both card-present patterns; what must not
    // happen is a region item arguing for out_of_region_use.
    const regionItems = history(rows, "T1").filter((i) => /billing region/.test(i.summary));
    expect(regionItems.some((i) => i.supports.includes("out_of_region_use"))).toBe(false);
  });

  it("does not call a single region 'home' on no comparison", () => {
    const item = history([...home(4), row({ txn_id: "T1", channel: "in_person", addr1: "204" })], "T1").find((i) =>
      i.summary.includes("the region this card is used in most"),
    );
    expect(item).toBeUndefined();
  });

  it("reads one away region spanning several days as a trip, not a clone", () => {
    // docs/DATASET_README.md: "Several days of purchases in one new region is
    // a trip, not a clone."
    const rows = [
      ...home(5),
      row({ txn_id: "A1", channel: "in_person", addr1: "330", ts: "2016-11-08T09:00:00Z" }),
      row({ txn_id: "A2", channel: "in_person", addr1: "330", ts: "2016-11-10T21:00:00Z" }),
      row({ txn_id: "A3", channel: "in_person", addr1: "330", ts: "2016-11-11T12:00:00Z" }),
    ];
    const item = history(rows, "A3").find((i) => i.summary.includes("billing regions in this window"));
    expect(item).toBeDefined();
    expect(item?.summary).toMatch(/shape of a trip/);
    expect(item?.supports).toEqual([]);
    expect(item?.contradicts).toEqual(["out_of_region_use"]);
  });

  it("names out_of_region_use for a short burst in one away region, weaker than two away regions", () => {
    const burst = [
      ...home(5),
      row({ txn_id: "A1", channel: "in_person", addr1: "330", ts: "2016-11-11T09:00:00Z" }),
      row({ txn_id: "A2", channel: "in_person", addr1: "330", ts: "2016-11-11T15:00:00Z" }),
    ];
    const one = history(burst, "A2").find((i) => i.summary.includes("billing regions in this window"));
    expect(one?.supports).toEqual(["out_of_region_use"]);
    expect(one?.weight_hint).toBe(0.55);

    const two = history(
      [...burst, row({ txn_id: "B1", channel: "in_person", addr1: "410", ts: "2016-11-11T16:00:00Z" })],
      "B1",
    ).find((i) => i.summary.includes("billing regions in this window"));
    expect(two?.supports).toEqual(["out_of_region_use"]);
    expect(two?.weight_hint).toBe(0.7);
  });
});
