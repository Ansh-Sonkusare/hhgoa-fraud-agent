import { describe, expect, it } from "vitest";
import { makeRetrieveSimilarCases, scoreSimilarCases, coerceFingerprint } from "../../rag/src/retrieve.js";
import { AnyToolResultSchema } from "../../contracts/src/toolEnvelope.js";
import type { VectorStore } from "../../rag/src/store/vectorStore.js";
import type { CaseMemoryRecord } from "../../rag/src/types.js";
import { LocalJsonVectorStore } from "../../rag/src/store/vectorStore.js";
import { bowEmbedFn, makeCaseMemoryRecord } from "./helpers.js";

const P = (pattern: string): CaseMemoryRecord["fingerprint"] => ({
  pattern: pattern as CaseMemoryRecord["fingerprint"]["pattern"],
  entity_ids: [{ type: "Customer", id: "C001" }],
  amount_band: "100_to_500",
  device_signals: [],
  address_signals: [],
  outcome: "confirmed_fraud",
});

function seededCaseStore(): VectorStore<CaseMemoryRecord> {
  const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
  const cases: CaseMemoryRecord[] = [
    makeCaseMemoryRecord({
      case_id: "CC-0100",
      customer_id: "C001",
      visible_from: "2016-07-02 00:00:00",
      summary_text: "Cardholder denied an online purchase from a brand new device",
      fingerprint: P("card_not_present_new_device"),
    }),
    makeCaseMemoryRecord({
      case_id: "CC-0200",
      customer_id: "C002",
      visible_from: "2016-08-15 00:00:00",
      summary_text: "small online authorization sequence then a larger purchase", // matches fingerprints for card_testing
      pattern: "card_testing",
      fingerprint: {
        pattern: "card_testing",
        entity_ids: [{ type: "Customer", id: "C002" }],
        amount_band: "100_to_500",
        device_signals: [],
        address_signals: [],
        outcome: "confirmed_fraud",
      },
    }),
    makeCaseMemoryRecord({
      case_id: "CC-0300",
      customer_id: "C003",
      visible_from: "2016-10-01 00:00:00",
      summary_text: "travel for a wedding; card used in a distant region once",
      pattern: "out_of_region_use",
      fingerprint: {
        pattern: "out_of_region_use",
        entity_ids: [{ type: "Customer", id: "C003" }],
        amount_band: "1000_to_5000",
        device_signals: [],
        address_signals: [],
        outcome: "cleared",
      },
    }),
  ];
  for (const c of cases) store.upsert(c.case_id, c.embedding, c);
  return store;
}

describe("scoreSimilarCases", () => {
  it("scores resolved cases the agent could have seen by as_of", async () => {
    const store = seededCaseStore();
    const fp = {
      ...P("card_testing"),
      entity_ids: [{ type: "Customer", id: "C002" }],
    };
    const scored = await scoreSimilarCases(store, bowEmbedFn, fp, "2016-09-01 00:00:00");
    // CC-0200 (same pattern+entity, word overlap) ranks above the
    // later-visible out-of-region case and the unrelated one.
    expect(scored[0]!.case_id).toBe("CC-0200");
    expect(scored[0]!.overlap_reason).toContain("same pattern");
  });

  it("never returns unresolved or future records as precedent", async () => {
    const store = seedFutureAndOpenCases();
    const scored = await scoreSimilarCases(store, bowEmbedFn, P("card_not_present_fraud"), "2016-07-01 00:00:00");
    const ids = scored.map((s) => s.case_id);
    expect(ids).not.toContain("CC-FUTURE"); // visible_from after as_of
    expect(ids).not.toContain("CC-OPEN"); // outcome unresolved
  });

  it("returns an empty list with a match-window explanation when nothing qualifies", async () => {
    const store = seedFutureAndOpenCases();
    const scored = await scoreSimilarCases(store, bowEmbedFn, P("card_testing"), "2016-07-01 00:00:00");
    expect(scored.length).toBe(0);
  });
});

describe("retrieve_similar_cases (contract tool)", () => {
  it("produces a contract-shaped, contract-schema-valid result", async () => {
    const store = seededCaseStore();
    const result = await makeRetrieveSimilarCases(store, bowEmbedFn)(
      { pattern: "card_testing", entity_ids: [{ type: "Customer", id: "C002" }] },
      "2016-09-01 00:00:00",
      5,
    );
    expect(AnyToolResultSchema.safeParse(result).success).toBe(true);
    expect(result.tool).toBe("retrieve_similar_cases");
    expect(result.via).toBe("rag");
    expect(result.as_of).toBe("2016-09-01 00:00:00");
    for (const c of result.data.cases) {
      expect(c.case_id).toMatch(/^CC-/);
      expect(typeof c.score).toBe("number");
      expect(["confirmed_fraud", "cleared"]).toContain(c.outcome);
      expect(c.overlap_reason.length).toBeGreaterThan(0);
    }
  });

  it("returns a failing envelope (not a throw) for an invalid as_of", async () => {
    const store = seededCaseStore();
    const result = await makeRetrieveSimilarCases(store, bowEmbedFn)(
      { pattern: "card_testing", entity_ids: [] },
      "not-a-date",
      5,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("as_of");
    expect(result.data).toEqual({ cases: [] });
  });
});

describe("coerceFingerprint", () => {
  it("fills missing fields from a partial probe fingerprint", () => {
    const fp = coerceFingerprint({ pattern: "card_testing", entity_ids: [{ type: "Card", id: "K1" }] });
    expect(fp.outcome).toBe("unresolved");
    expect(fp.entity_ids).toEqual([{ type: "Card", id: "K1" }]);
    expect(fp.amount_band).toBe("under_100");
    expect(fp.device_signals).toEqual([]);
    expect(fp.address_signals).toEqual([]);
  });
});

function seedFutureAndOpenCases(): VectorStore<CaseMemoryRecord> {
  const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
  const future = makeCaseMemoryRecord({
    case_id: "CC-FUTURE",
    visible_from: "2016-12-01 00:00:00",
    summary_text: "complex account takeover across many devices",
    fingerprint: P("account_takeover"),
  });
  const open = makeCaseMemoryRecord({
    case_id: "CC-OPEN",
    visible_from: "2016-06-01 00:00:00",
    summary_text: "small online authorization sequence then a larger purchase",
    pattern: "card_testing",
    fingerprint: { ...P("card_testing"), outcome: "unresolved" },
    outcome: "unresolved",
  });
  store.upsert(future.case_id, future.embedding, future);
  store.upsert(open.case_id, open.embedding, open);
  return store;
}