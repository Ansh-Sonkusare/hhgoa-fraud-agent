import { describe, it, expect } from "vitest";
import { buildEvidenceForTool, createEvidenceIdGen } from "../../agent/src/evidenceBuilder.js";

// The single-high-risk branch of txnHistoryEvidence used to assert "online",
// "a product code this card has not used" and "no burst" without computing
// any of them, and backed card_not_present_fraud with that text. These pin
// that each clause is now derived from the rows, and that the pattern is only
// supported when the facts that define it actually hold.

const AS_OF = "2016-11-12T00:35:00Z";

function row(over: Record<string, unknown>): Record<string, unknown> {
  return { txn_id: "T0", ts: "2016-11-10T10:00:00Z", amount_usd: 40, product_cd: "W",
    channel: "online", risk_score: 0.05, ...over };
}

function headline(rows: Record<string, unknown>[], flaggedTxnId?: string) {
  const items = buildEvidenceForTool(
    "get_transaction_history",
    { rows, stats: { count: rows.length, total_amount_usd: 0, window: "168h" } },
    createEvidenceIdGen(),
    AS_OF,
    undefined,
    flaggedTxnId,
  );
  const h = items.find((i) => i.summary.startsWith("Single "));
  if (!h) throw new Error("no single-transaction headline");
  return h;
}

describe("single high-risk transaction evidence", () => {
  it("supports card_not_present_fraud only for an online charge in a genuinely new product code", () => {
    const h = headline([
      row({ txn_id: "A", product_cd: "W" }),
      row({ txn_id: "B", product_cd: "W", ts: "2016-11-10T12:00:00Z" }),
      row({ txn_id: "F", product_cd: "C", ts: "2016-11-11T09:00:00Z", risk_score: 0.9 }),
    ]);
    expect(h.summary).toContain("online");
    expect(h.summary).toContain("none of this card's 2 earlier transactions");
    expect(h.supports).toEqual(["card_not_present_fraud"]);
  });

  it("does not claim a new product code the card has already used", () => {
    const h = headline([
      row({ txn_id: "A", product_cd: "C" }),
      row({ txn_id: "F", product_cd: "C", ts: "2016-11-11T09:00:00Z", risk_score: 0.9 }),
    ]);
    expect(h.summary).toContain("has used earlier");
    expect(h.summary).not.toContain("has not used");
    expect(h.supports).toEqual([]);
  });

  it("does not call a card-present charge online, and does not back a CNP pattern with it", () => {
    const h = headline([
      row({ txn_id: "A", product_cd: "W", channel: "in_person" }),
      row({ txn_id: "F", product_cd: "C", channel: "in_person", ts: "2016-11-11T09:00:00Z", risk_score: 0.9 }),
    ]);
    expect(h.summary).toContain("card-present");
    expect(h.summary).not.toContain("online");
    expect(h.supports).toEqual([]);
  });

  it("makes no novelty claim when there is nothing earlier to compare against", () => {
    const h = headline([row({ txn_id: "F", product_cd: "C", risk_score: 0.9 })]);
    expect(h.summary).toContain("no earlier activity");
    expect(h.supports).toEqual([]);
  });

  it("never asserts facts it did not compute", () => {
    const h = headline([
      row({ txn_id: "A" }),
      row({ txn_id: "F", product_cd: "C", ts: "2016-11-11T09:00:00Z", risk_score: 0.9 }),
    ]);
    expect(h.summary).not.toMatch(/no burst|no other unusual/);
  });

  it("says so when the high-risk transaction is not the flagged charge, and backs no pattern with it (CC-5194)", () => {
    const rows = [
      row({ txn_id: "A", product_cd: "W", channel: "in_person" }),
      row({ txn_id: "F", product_cd: "W", channel: "online", ts: "2016-11-11T08:00:00Z" }),
      row({ txn_id: "H", product_cd: "C", channel: "online", ts: "2016-11-11T09:00:00Z", risk_score: 0.9 }),
    ];
    const h = headline(rows, "F");
    expect(h.summary).toContain("is not the flagged charge: txn H");
    expect(h.supports).toEqual([]);
    // The same row, when it IS the flagged charge, keeps the plain headline and its support.
    const same = headline(rows, "H");
    expect(same.summary.startsWith("Single $40.00 online purchase")).toBe(true);
    expect(same.supports).toEqual(["card_not_present_fraud"]);
  });
});
