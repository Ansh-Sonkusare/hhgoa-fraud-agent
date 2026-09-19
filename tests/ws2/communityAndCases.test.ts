import { describe, expect, it } from "vitest";
import { COMMUNITY_PARAMS, KNOWN, runQuery } from "./helpers.js";

describe("find_prior_cases", () => {
  it("matches a case referencing a stub card via the resolved real customer (docs/decisions.md)", async () => {
    const r = await runQuery<{ cases: { case_id: string; outcome: string; pattern: string }[] }>(
      "find_prior_cases",
      { card_id: KNOWN.realCardForStub, as_of: KNOWN.lateAsOf },
    );
    const ids = r.cases.map((c) => c.case_id);
    expect(ids).toContain(KNOWN.caseIdForStub);
  });

  it("returns no cases opened after the given as_of", async () => {
    const r = await runQuery<{ cases: unknown[] }>("find_prior_cases", {
      card_id: KNOWN.realCardForStub,
      as_of: "2015-01-01 00:00:00",
    });
    expect(r.cases.length).toBe(0);
  });
});

describe("community_lookup", () => {
  it("a card's own community always includes itself and has size >= 1", async () => {
    const r = await runQuery<{ community_id: string; size: number }>("community_lookup", {
      card_id: KNOWN.txnCardId,
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    expect(r.size).toBeGreaterThanOrEqual(1);
    expect(r.community_id.length).toBeGreaterThan(0);
  });

  // The community id is the hash-min WCC label, i.e. the lexicographically
  // smallest member card id. Looking up from the key card must therefore
  // return that same card as the id.
  it("synthesizes the community id from the smallest member card id", async () => {
    const r = await runQuery<{ community_id: string; size: number }>("community_lookup", {
      card_id: KNOWN.txnCardId,
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    expect(r.community_id.startsWith("comm_")).toBe(true);
    const key = r.community_id.slice("comm_".length);
    expect(key <= KNOWN.txnCardId).toBe(true);
    const again = await runQuery<{ community_id: string; size: number }>("community_lookup", {
      card_id: key,
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    expect(again.community_id).toBe(r.community_id);
    expect(again.size).toBe(r.size);
  });

  it("honors as_of: a community can only be smaller at an earlier snapshot", async () => {
    const late = await runQuery<{ size: number }>("community_lookup", {
      card_id: KNOWN.txnCardId,
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    const early = await runQuery<{ size: number }>("community_lookup", {
      card_id: KNOWN.txnCardId,
      as_of: KNOWN.asOfBeforeAnyHistory,
      ...COMMUNITY_PARAMS,
    });
    expect(early.size).toBeLessThanOrEqual(late.size);
    expect(early.size).toBeGreaterThanOrEqual(1);
  });
});
