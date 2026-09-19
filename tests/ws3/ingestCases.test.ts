import { describe, expect, it } from "vitest";
import { ingestClosedCases } from "../../rag/src/ingestCases.js";
import { getTransactionSignals } from "../../rag/src/sources/transactionSignals.js";
import { fakeEmbedFnWithProgress } from "./helpers.js";

describe("ingestClosedCases", () => {
  it("fingerprints + embeds closed cases with visible_from = closed_at", async () => {
    const records = await ingestClosedCases(fakeEmbedFnWithProgress, {
      withTransactionSignals: false,
      limit: 25,
    });
    expect(records.length).toBe(25);
    const [first] = records;
    expect(first!.source).toBe("closed_case_history");
    expect(first!.visible_from).toBe(first!.closed_at);
    expect(first!.embedding.length).toBeGreaterThan(0);
    expect(first!.fingerprint).toMatchObject({
      pattern: first!.pattern,
      outcome: first!.outcome,
    });
    expect(first!.fingerprint.entity_ids).toEqual(
      expect.arrayContaining([
        { type: "Customer", id: first!.customer_id },
        { type: "Card", id: first!.card_id },
      ]),
    );
    // Cleared cases carry pattern "none" and no first-fraud txn.
    const cleared = records.find((r) => r.outcome === "cleared");
    if (cleared) {
      expect(cleared.pattern).toBe("none");
      expect(cleared.fingerprint.amount_band).toBeTruthy();
    }
  });

  it("always sets the exposure amount band", async () => {
    const records = await ingestClosedCases(fakeEmbedFnWithProgress, {
      withTransactionSignals: false,
      limit: 10,
    });
    for (const r of records) {
      expect(["under_100", "100_to_500", "500_to_1000", "1000_to_5000", "over_5000"]).toContain(
        r.fingerprint.amount_band,
      );
    }
  });
});

describe("getTransactionSignals (bounded streaming join)", () => {
  it(
    "pulls device/address signals for a few real transaction ids",
    async () => {
      const ids = new Set(["3000120", "3000121"]);
      const signals = await getTransactionSignals(ids);
      expect(signals.size).toBeGreaterThan(0);
      for (const [, s] of signals) {
        expect(s.txn_id.length).toBeGreaterThan(0);
        expect(typeof s.addr1).toBe("string");
        expect(typeof s.card_network).toBe("string");
        // device_profile is null for in-person txns but present (possibly
        // null) for online; the join must never throw on either.
        expect(Object.hasOwn(s, "device_profile")).toBe(true);
        expect(typeof s.device_is_new).toBe("boolean");
      }
    },
    60_000,
  );

  it("returns an empty map for an empty id set", async () => {
    const signals = await getTransactionSignals(new Set());
    expect(signals.size).toBe(0);
  });
});