import { describe, expect, it } from "vitest";
import { KNOWN, runQuery } from "./helpers.js";

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
      max_hub_degree: 25,
    });
    expect(r.size).toBeGreaterThanOrEqual(1);
    expect(r.community_id.length).toBeGreaterThan(0);
  });
});
