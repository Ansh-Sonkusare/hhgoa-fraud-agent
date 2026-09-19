import { describe, expect, it } from "vitest";
import { KNOWN, runQuery } from "./helpers.js";

describe("resolve_trigger", () => {
  it("resolves a txn id to its real card and customer", async () => {
    const r = await runQuery("resolve_trigger", {
      entity_type: "txn",
      entity_id: KNOWN.txnId,
      as_of: KNOWN.asOfAfterTxn,
    });
    expect(r).toMatchObject({
      txn_id: KNOWN.txnId,
      card_id: KNOWN.txnCardId,
      customer_id: KNOWN.txnCustomerId,
    });
  });

  it("ignores a txn that has not happened yet as of the given time (PRD sec.8.1)", async () => {
    const r = await runQuery("resolve_trigger", {
      entity_type: "txn",
      entity_id: KNOWN.txnId,
      as_of: KNOWN.asOfBeforeTxn,
    });
    expect(r).toMatchObject({ card_id: "", customer_id: "" });
  });

  it("resolves a card id directly to its customer", async () => {
    const r = await runQuery("resolve_trigger", {
      entity_type: "card",
      entity_id: KNOWN.txnCardId,
      as_of: KNOWN.asOfAfterTxn,
    });
    expect(r).toMatchObject({ card_id: KNOWN.txnCardId, customer_id: KNOWN.txnCustomerId });
  });

  it("resolves a customer id to (at least) one owned card", async () => {
    const r = await runQuery<{ customer_id: string; card_id: string }>("resolve_trigger", {
      entity_type: "customer",
      entity_id: KNOWN.txnCustomerId,
      as_of: KNOWN.asOfAfterTxn,
    });
    expect(r.customer_id).toBe(KNOWN.txnCustomerId);
    expect(r.card_id.length).toBeGreaterThan(0);
  });
});

describe("get_entity_profile", () => {
  it("returns card attributes with as_of-recomputed txn_count (not the full-history baked value)", async () => {
    const early = await runQuery<{ txn_count_as_of: number }>("get_entity_profile", {
      entity_type: "card",
      entity_id: KNOWN.txnCardId,
      as_of: KNOWN.asOfBeforeTxn,
    });
    const late = await runQuery<{ txn_count_as_of: number }>("get_entity_profile", {
      entity_type: "card",
      entity_id: KNOWN.txnCardId,
      as_of: KNOWN.lateAsOf,
    });
    // Strictly more history is visible by the later as_of -- proves the
    // count is recomputed per as_of, not the load-time baked aggregate.
    expect(late.txn_count_as_of).toBeGreaterThan(early.txn_count_as_of);
  });

  it("returns txn attributes only when ts <= as_of", async () => {
    const before = await runQuery<{ entity_id: string }>("get_entity_profile", {
      entity_type: "txn",
      entity_id: KNOWN.txnId,
      as_of: KNOWN.asOfBeforeTxn,
    });
    expect(before.entity_id).toBe("");

    const after = await runQuery<{ entity_id: string; card_id: string }>("get_entity_profile", {
      entity_type: "txn",
      entity_id: KNOWN.txnId,
      as_of: KNOWN.asOfAfterTxn,
    });
    expect(after.entity_id).toBe(KNOWN.txnId);
    expect(after.card_id).toBe(KNOWN.txnCardId);
  });
});
