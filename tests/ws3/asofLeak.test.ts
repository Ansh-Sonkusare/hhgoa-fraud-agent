/**
 * PRD §8.1 temporal-correctness guard: every graph/RAG/memory tool takes
 * `as_of` and MUST ignore information after it. These tests assert the
 * leak rule on the retrieval + memory path end to end, using controlled
 * `visible_from` timestamps so any future-window leakage is visible.
 */
import { describe, expect, it } from "vitest";
import { makeRetrieveSimilarCases } from "../../rag/src/retrieve.js";
import { writeCaseToMemory } from "../../rag/src/memory.js";
import type { VectorStore } from "../../rag/src/store/vectorStore.js";
import type { CaseMemoryRecord } from "../../rag/src/types.js";
import { LocalJsonVectorStore } from "../../rag/src/store/vectorStore.js";
import { fakeEmbedFn, makeCaseMemoryRecord } from "./helpers.js";

function storeWith(records: CaseMemoryRecord[]): VectorStore<CaseMemoryRecord> {
  const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
  for (const r of records) store.upsert(r.case_id, r.embedding, r);
  return store;
}

const probe = { pattern: "card_testing", entity_ids: [{ type: "Card", id: "K1" }] };

describe("PRD §8.1 as_of leakage guard", () => {
  it("never returns a case whose visible_from is after as_of", async () => {
    const store = storeWith([
      makeCaseMemoryRecord({
        case_id: "CC-OLD",
        visible_from: "2016-07-02 00:00:00",
        summary_text: "card testing with tiny authorizations first",
      }),
      // Closed in December — not knowable to an investigation at the date below.
      makeCaseMemoryRecord({
        case_id: "CC-DEC",
        visible_from: "2016-12-01 00:00:00",
        summary_text: "card testing with tiny authorizations first",
      }),
    ]);

    const result = await makeRetrieveSimilarCases(store, fakeEmbedFn)(probe, "2016-09-01 00:00:00", 10);
    const ids = result.data.cases.map((c) => c.case_id);
    expect(ids).toContain("CC-OLD");
    expect(ids).not.toContain("CC-DEC");
  });

  it("does not leak the future: same case, earlier as_of -> nothing", async () => {
    const store = storeWith([
      makeCaseMemoryRecord({
        case_id: "CC-THEN",
        visible_from: "2016-08-01 00:00:00",
        summary_text: "small online authorizations then a bigger purchase",
      }),
    ]);
    const result = await makeRetrieveSimilarCases(store, fakeEmbedFn)(probe, "2016-07-15 00:00:00", 10);
    expect(result.data.cases).toEqual([]);
  });

  it("still finds the same case once as_of reaches its visible_from", async () => {
    const store = storeWith([
      makeCaseMemoryRecord({
        case_id: "CC-THEN",
        visible_from: "2016-08-01 00:00:00",
        summary_text: "card testing sequence",
      }),
    ]);
    const result = await makeRetrieveSimilarCases(store, fakeEmbedFn)(probe, "2016-08-01 00:00:00", 10);
    expect(result.data.cases.map((c) => c.case_id)).toContain("CC-THEN");
  });

  it("memory written at MEMORY_UPDATE becomes visible only from its as_of onward", async () => {
    const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
    await writeCaseToMemory(store, fakeEmbedFn, {
      case_id: "HHG-021",
      case_record: {
        status: "closed_fraud",
        verdict: "fraud",
        fraud_probability: 0.9,
        pattern: "card_testing",
        pattern_description: "",
        affected_txn_ids: ["3000999"],
        first_suspicious_txn_id: "3000999",
        connected_card_ids: [],
        connected_device_profiles: [],
        exposure_usd: 250,
        evidence: [],
        similar_prior_cases: [],
        summary: "tiny authorizations then a larger purchase; denied by customer",
        written_to_graph: false,
        graph_case_id: "",
      },
      customer_id: "C077",
      card_id: "C077-K1",
      as_of: "2016-10-01 09:00:00",
    });

    // A probe *before* the memory update must not see the record.
    const before = await makeRetrieveSimilarCases(store, fakeEmbedFn)(probe, "2016-09-30 00:00:00", 10);
    expect(before.data.cases.map((c) => c.case_id)).not.toContain("HHG-021");

    // A probe *after* the memory update can cite it.
    const after = await makeRetrieveSimilarCases(store, fakeEmbedFn)(probe, "2016-10-01 09:00:00", 10);
    expect(after.data.cases.map((c) => c.case_id)).toContain("HHG-021");
  });

  it("never surfaces unresolved records as precedent, at any as_of", async () => {
    const store = storeWith([
      makeCaseMemoryRecord({
        case_id: "CC-PENDING",
        visible_from: "2016-05-01 00:00:00",
        summary_text: "card testing sequence",
        outcome: "unresolved",
      }),
    ]);
    const result = await makeRetrieveSimilarCases(store, fakeEmbedFn)(probe, "2016-12-31 00:00:00", 10);
    expect(result.data.cases).toEqual([]);
  });
});