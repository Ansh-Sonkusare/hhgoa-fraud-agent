import { describe, expect, it } from "vitest";
import { scorePolicyChunks, scoreSimilarCases } from "../../rag/src/retrieve.js";
import { cosineSimilarity } from "../../rag/src/embeddings.js";
import { LocalJsonVectorStore } from "../../rag/src/store/vectorStore.js";
import { graphIdFor, tigerGraphConnectionFromEnv, type GraphVectorScores } from "../../rag/src/store/tigergraphIndex.js";
import type { CaseMemoryRecord, PolicyChunkRecord } from "../../rag/src/types.js";
import { bowEmbedFn, makeCaseMemoryRecord, makePolicyChunk } from "./helpers.js";

/**
 * Stands in for TigerGraph's vector_search: the same cosine over the same
 * vectors, keyed by graph id, with the option to leave vectors out (an
 * unsynced index).
 */
function fakeGraph(
  chunks: readonly PolicyChunkRecord[],
  cases: readonly CaseMemoryRecord[],
  omit: ReadonlySet<string> = new Set(),
): GraphVectorScores & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scoreChunks: (q) => {
      calls.push("chunks");
      return Promise.resolve(new Map(chunks.filter((c) => !omit.has(c.chunk_id)).map((c) => [c.chunk_id, cosineSimilarity(q, c.embedding)])));
    },
    scoreCases: (q) => {
      calls.push("cases");
      return Promise.resolve(new Map(cases.filter((c) => !omit.has(graphIdFor(c))).map((c) => [graphIdFor(c), cosineSimilarity(q, c.embedding)])));
    },
  };
}

const CHUNK_TEXTS: [string, string | undefined, string][] = [
  ["pc_1", "card_testing", "tiny online authorizations before a larger purchase"],
  ["pc_2", undefined, "R5 three or more small online authorizations within an hour"],
  ["pc_3", "out_of_region_use", "card present purchases in a new billing region"],
  ["pc_4", "account_takeover", "stolen credentials mixed channel activity device anomalies"],
];

async function chunkStore(): Promise<{ store: LocalJsonVectorStore<PolicyChunkRecord>; records: PolicyChunkRecord[] }> {
  const store = new LocalJsonVectorStore<PolicyChunkRecord>("/tmp/opencode/ws3-graph-nowhere.json");
  const records: PolicyChunkRecord[] = [];
  for (const [id, pattern_id, text] of CHUNK_TEXTS) {
    const [embedding] = await bowEmbedFn([text]);
    const r = makePolicyChunk({ chunk_id: id, pattern_id, text, embedding: embedding! });
    records.push(r);
    store.upsert(id, r.embedding, r);
  }
  return { store, records };
}

async function caseStore(): Promise<{ store: LocalJsonVectorStore<CaseMemoryRecord>; records: CaseMemoryRecord[] }> {
  const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-graph-cases.json");
  const specs: [string, string, string, CaseMemoryRecord["source"]][] = [
    ["CC-0001", "2016-07-02 00:00:00", "online purchase from a brand new device", "closed_case_history"],
    ["CC-0002", "2016-08-15 00:00:00", "small online authorization sequence then a larger purchase", "closed_case_history"],
    ["CC-0003", "2016-10-01 00:00:00", "card used in a distant region once", "closed_case_history"],
    ["HHG-900", "2016-08-20 00:00:00", "agent closed an online new device case", "agent_written"],
  ];
  const records: CaseMemoryRecord[] = [];
  for (const [case_id, visible_from, summary_text, source] of specs) {
    const [embedding] = await bowEmbedFn([summary_text]);
    const r = makeCaseMemoryRecord({ case_id, visible_from, summary_text, source, embedding: embedding! });
    records.push(r);
    store.upsert(case_id, r.embedding, r);
  }
  return { store, records };
}

describe("graph-scored retrieval matches local retrieval", () => {
  it("policy chunks: same ids, order and scores, with and without a pattern filter", async () => {
    const { store, records } = await chunkStore();
    const graph = fakeGraph(records, []);
    for (const pattern of [undefined, "card_testing", "out_of_region_use"]) {
      const local = await scorePolicyChunks(store, bowEmbedFn, "small online authorizations then a purchase", pattern, 3);
      const viaGraph = await scorePolicyChunks(store, bowEmbedFn, "small online authorizations then a purchase", pattern, 3, graph);
      expect(viaGraph.map((r) => [r.id, r.score])).toEqual(local.map((r) => [r.id, r.score]));
    }
    expect(graph.calls).toContain("chunks");
  });

  it("similar cases: same ranking and as_of eligibility, agent-written cases looked up by GRAPH- id", async () => {
    const { store, records } = await caseStore();
    const graph = fakeGraph([], records);
    const fp = { summary_text: "new device online purchase", pattern: "card_not_present_new_device" };
    const local = await scoreSimilarCases(store, bowEmbedFn, fp, "2016-09-01 00:00:00");
    const viaGraph = await scoreSimilarCases(store, bowEmbedFn, fp, "2016-09-01 00:00:00", graph);
    expect(viaGraph.map((r) => [r.record.case_id, r.score])).toEqual(local.map((r) => [r.record.case_id, r.score]));
    // CC-0003 becomes visible only on 2016-10-01.
    expect(viaGraph.map((r) => r.record.case_id)).not.toContain("CC-0003");
    expect(viaGraph.map((r) => r.record.case_id)).toContain("HHG-900");
    expect(graph.calls).toEqual(["cases"]);
  });
});

describe("an incomplete graph index fails loudly", () => {
  it("raises when a policy chunk has no graph embedding", async () => {
    const { store, records } = await chunkStore();
    await expect(scorePolicyChunks(store, bowEmbedFn, "anything", undefined, 3, fakeGraph(records, [], new Set(["pc_2"])))).rejects.toThrow(
      /no embedding for 1 policy chunk.*pc_2.*sync-graph/,
    );
  });

  it("raises when an eligible case has no graph embedding, and ignores ones not yet visible", async () => {
    const { store, records } = await caseStore();
    const fp = { summary_text: "new device online purchase" };
    await expect(scoreSimilarCases(store, bowEmbedFn, fp, "2016-09-01 00:00:00", fakeGraph([], records, new Set(["GRAPH-HHG-900"])))).rejects.toThrow(
      /no embedding for 1 eligible case.*GRAPH-HHG-900/,
    );
    // CC-0003 is not eligible before 2016-10-01, so its absence is not an error.
    await expect(scoreSimilarCases(store, bowEmbedFn, fp, "2016-09-01 00:00:00", fakeGraph([], records, new Set(["CC-0003"])))).resolves.toBeDefined();
  });
});

describe("tigerGraphConnectionFromEnv", () => {
  it("keeps an explicit port and adds the REST port otherwise", () => {
    expect(tigerGraphConnectionFromEnv({ TIGERGRAPH_HOST: "http://localhost:9000" }).baseUrl).toBe("http://localhost:9000");
    expect(tigerGraphConnectionFromEnv({ TIGERGRAPH_HOST: "http://tg", TIGERGRAPH_REST_PORT: "14240" }).baseUrl).toBe("http://tg:14240");
    expect(() => tigerGraphConnectionFromEnv({})).toThrow(/TIGERGRAPH_HOST/);
  });
});
