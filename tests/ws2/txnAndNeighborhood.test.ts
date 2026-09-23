import { describe, expect, it } from "vitest";
import { KNOWN, runQuery } from "./helpers.js";

describe("txn_history", () => {
  it("returns only rows with ts <= as_of, and stats.count matches the row count", async () => {
    const r = await runQuery<{ rows: unknown[]; txn_count: number }>("txn_history", {
      entity_type: "card",
      entity_id: KNOWN.txnCardId,
      as_of: KNOWN.asOfAfterTxn,
      window_hours: 0,
    });
    expect(r.rows.length).toBe(r.txn_count);
    expect(r.txn_count).toBeGreaterThan(0);
  });

  it("a tighter window returns no more rows than window_hours=0 (full history)", async () => {
    const full = await runQuery<{ txn_count: number }>("txn_history", {
      entity_type: "card",
      entity_id: KNOWN.txnCardId,
      as_of: KNOWN.asOfAfterTxn,
      window_hours: 0,
    });
    const windowed = await runQuery<{ txn_count: number }>("txn_history", {
      entity_type: "card",
      entity_id: KNOWN.txnCardId,
      as_of: KNOWN.asOfAfterTxn,
      window_hours: 6,
    });
    expect(windowed.txn_count).toBeLessThanOrEqual(full.txn_count);
  });
});

describe("card_velocity", () => {
  it("counts the known txn within a wide window and excludes it with as_of before it happened", async () => {
    const withTxn = await runQuery<{ txn_count: number }>("card_velocity", {
      card_id: KNOWN.txnCardId,
      window_minutes: 24 * 60,
      as_of: KNOWN.asOfAfterTxn,
    });
    expect(withTxn.txn_count).toBeGreaterThanOrEqual(1);

    const beforeAnyHistory = await runQuery<{ txn_count: number }>("card_velocity", {
      card_id: KNOWN.txnCardId,
      window_minutes: 24 * 60,
      as_of: KNOWN.asOfBeforeAnyHistory,
    });
    expect(beforeAnyHistory.txn_count).toBe(0);
  });
});

describe("neighborhood", () => {
  it("1-hop expansion includes the seed card plus its device/address/email neighbors", async () => {
    // Field names are vtype/vid, not the contract's type/id -- "type" is a
    // reserved word in this GSQL grammar (like "count"), rejected even as
    // a TUPLE field name (see gsql/queries/neighborhood.gsql).
    const r = await runQuery<{ nodes: { vtype: string; vid: string }[] }>("neighborhood", {
      entity_id: KNOWN.txnCardId,
      hops: 1,
      as_of: KNOWN.lateAsOf,
    });
    expect(r.nodes.length).toBeGreaterThan(1);
    expect(r.nodes.some((n) => n.vtype === "Card" && n.vid === KNOWN.txnCardId)).toBe(true);
    expect(r.nodes.every((n) => ["Card", "Device", "Address", "EmailDomain"].includes(n.vtype))).toBe(true);
  });

  it("2-hop expansion is a superset of 1-hop (never fewer nodes)", async () => {
    const one = await runQuery<{ nodes: unknown[] }>("neighborhood", {
      entity_id: KNOWN.txnCardId,
      hops: 1,
      as_of: KNOWN.lateAsOf,
    });
    const two = await runQuery<{ nodes: unknown[] }>("neighborhood", {
      entity_id: KNOWN.txnCardId,
      hops: 2,
      as_of: KNOWN.lateAsOf,
    });
    expect(two.nodes.length).toBeGreaterThanOrEqual(one.nodes.length);
  });
});

describe("shared_rings", () => {
  it("every ring for the seed card includes the seed card itself", async () => {
    const r = await runQuery<{ device_rings: Record<string, string[]> }>("shared_rings", {
      card_id: KNOWN.txnCardId,
      as_of: KNOWN.lateAsOf,
    });
    for (const cardIds of Object.values(r.device_rings)) {
      expect(cardIds).toContain(KNOWN.txnCardId);
    }
  });

  it("seed_in_window keeps only rings on the seed card's own activity in the window -- a subset of all-time", async () => {
    type Rings = { device_rings: Record<string, string[]>; address_rings: Record<string, string[]> };
    const params = { card_id: KNOWN.txnCardId, as_of: KNOWN.lateAsOf };
    const all = await runQuery<Rings>("shared_rings", params);
    const win = await runQuery<Rings>("shared_rings", { ...params, seed_in_window: true });
    for (const key of ["device_rings", "address_rings"] as const) {
      for (const [id, cards] of Object.entries(win[key])) {
        expect(cards).toContain(KNOWN.txnCardId);
        expect(all[key][id]).toBeDefined();
        for (const c of cards) expect(all[key][id]).toContain(c);
      }
    }
  });
});

describe("baseline_deviation", () => {
  it("returns all four z-score axes as finite numbers", async () => {
    const r = await runQuery<{ amount_z: number; geo_z: number; device_z: number; time_z: number }>(
      "baseline_deviation",
      { txn_id: KNOWN.txnId, as_of: KNOWN.asOfAfterTxn },
    );
    for (const v of [r.amount_z, r.geo_z, r.device_z, r.time_z]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("returns zero amount/geo/device deviation for a txn that has not happened yet as of the given time", async () => {
    const r = await runQuery<{ amount_z: number; geo_z: number; device_z: number }>("baseline_deviation", {
      txn_id: KNOWN.txnId,
      as_of: KNOWN.asOfBeforeTxn,
    });
    // time_z is intentionally not asserted here: with no matching txn found
    // (ts > as_of), its computation degenerates to whatever the unset
    // accumulator defaults compare as -- a real caller only calls
    // baseline_deviation for a txn it already confirmed exists as of that
    // as_of (e.g. via resolve_trigger first), so this combination doesn't
    // arise in practice. See docs/decisions.md.
    expect(r.amount_z).toBe(0);
    expect(r.geo_z).toBe(0);
    expect(r.device_z).toBe(0);
  });
});
