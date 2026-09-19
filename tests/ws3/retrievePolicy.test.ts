import { describe, expect, it } from "vitest";
import { makeRetrievePolicy, scorePolicyChunks } from "../../rag/src/retrieve.js";
import { AnyToolResultSchema } from "../../contracts/src/toolEnvelope.js";
import type { VectorStore } from "../../rag/src/store/vectorStore.js";
import type { PolicyChunkRecord } from "../../rag/src/types.js";
import { LocalJsonVectorStore } from "../../rag/src/store/vectorStore.js";
import { bowEmbedFn, bowEmbedVec, makePolicyChunk } from "./helpers.js";

function seededStore(): VectorStore<PolicyChunkRecord> {
  const store = new LocalJsonVectorStore<PolicyChunkRecord>("/tmp/opencode/ws3-nowhere.json");
  const chunks: PolicyChunkRecord[] = [
    makePolicyChunk({
      chunk_id: "pc_0001",
      source_doc: "DATASET_README.md#the-five-known-fraud-patterns",
      source_kind: "pattern",
      heading_path: "The five known fraud patterns > 1. Card testing.",
      pattern_id: "card_testing",
      text: "Card testing: a stolen card number is checked with tiny online authorizations before a larger purchase.",
    }),
    makePolicyChunk({
      chunk_id: "pc_0002",
      heading_path: "Fraud Policy > Rules > R5. Card testing.",
      text: "R5. Three or more small online authorizations on one card within an hour, followed by a larger purchase: recommend DECLINE_TRANSACTION and STEP_UP_AUTH.",
    }),
    makePolicyChunk({
      chunk_id: "pc_0003",
      heading_path: "Fraud Policy > Rules > R1. Verify before you block on a weak signal.",
      text: "R1. If the case rests on a single signal, recommend VERIFY_WITH_CUSTOMER or STEP_UP_AUTH before any block.",
    }),
    makePolicyChunk({
      chunk_id: "pc_0004",
      source_doc: "DATASET_README.md#the-five-known-fraud-patterns",
      source_kind: "pattern",
      heading_path: "The five known fraud patterns > 4. Out-of-region use.",
      pattern_id: "out_of_region_use",
      text: "Out-of-region use: card-present purchases in a new billing region with no history there.",
    }),
    makePolicyChunk({
      chunk_id: "pc_0005",
      source_doc: "FinCEN Advisory FIN-2011-A016: Account Takeover Activity",
      source_kind: "regulatory",
      heading_path: "FinCEN Advisory > Identifying Account Takeover Activity",
      text: "Financial institutions may detect account takeover through monitoring irregularities including unusual ATM activity.",
    }),
  ];
  // BOW-embed the seeded chunks so the store's cosine ranking is a true
  // word-overlap measure against the bowEmbedFn used for queries below.
  for (const c of chunks) store.upsert(c.chunk_id, bowEmbedVec(c.text), c);
  return store;
}

describe("scorePolicyChunks (vector top-k seeds)", () => {
  it("ranks chunks by vector similarity to the query", async () => {
    const store = seededStore();
    const scored = await scorePolicyChunks(store, bowEmbedFn, "card testing online authorization", undefined, 3);
    expect(scored.length).toBe(3);
    // The card_testing pattern chunk + R5 rule chunk share the query's words.
    expect(scored.map((s) => s.id)).toContain("pc_0001");
    expect(scored[0]!.score).toBeGreaterThanOrEqual(scored[1]!.score);
  });

  it("applies a pattern_id pre-filter", async () => {
    const store = seededStore();
    // k=2 (enough matches exist: pc_0001 + the R5 rule chunk) so the
    // unfiltered backfill (which kicks in below min(k, 3) matches) does
    // not pollute the result set with non-matching chunks.
    const scored = await scorePolicyChunks(store, bowEmbedFn, "card testing", "card_testing", 2);
    const recordOf = (id: string) => store.get(id)!;
    for (const s of scored) {
      const rec = recordOf(s.id);
      expect(rec.pattern_id === "card_testing" || rec.heading_path.includes("Rules > R5.")).toBe(true);
    }
  });

  it("backfills when the pattern filter over-narrows", async () => {
    const store = new LocalJsonVectorStore<PolicyChunkRecord>("/tmp/opencode/ws3-nowhere.json");
    store.upsert("pc_0001", bowEmbedVec("only pattern chunk"),
      makePolicyChunk({
        chunk_id: "pc_0001",
        pattern_id: "card_testing",
        text: "Card testing: tiny online authorization sequence.",
      }));
    const scored = await scorePolicyChunks(store, bowEmbedFn, "unrelated topic entirely", "card_testing", 3);
    // backfill returns the single chunk rather than zero.
    expect(scored.length).toBe(1);
  });
});

describe("retrieve_policy (hybrid: seeds + graph expansion)", () => {
  it("returns only contract-shaped chunks with expandable links", async () => {
    const store = seededStore();
    const result = await makeRetrievePolicy(store, bowEmbedFn)("card testing", "card_testing", 3);
    expect(AnyToolResultSchema.safeParse(result).success).toBe(true);
    expect(result.tool).toBe("retrieve_policy");
    expect(result.via).toBe("rag");
    expect(result.as_of).toBe("n/a");
    expect(result.data.chunks.length).toBeGreaterThan(0);
    for (const c of result.data.chunks) {
      expect(c.chunk_id).toBeTruthy();
      expect(c.source_doc).toBeTruthy();
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it("expands seed chunks to the pattern's required_evidence + permitted_actions", async () => {
    const store = seededStore();
    const result = await makeRetrievePolicy(store, bowEmbedFn)("card testing", "card_testing", 10);
    expect(result.data.required_evidence).toContain("txn_velocity_small_online_auths");
    expect(result.data.required_evidence).toContain("larger_purchase_follows_sequence");
    expect(result.data.permitted_actions).toEqual(
      expect.arrayContaining(["DECLINE_TRANSACTION", "STEP_UP_AUTH", "BLOCK_CARD"]),
    );
  });

  it("expands via a rule chunk's R-number even without an explicit pattern filter", async () => {
    const store = seededStore();
    // Query for the R5 rule text; no pattern_id passed.
    const result = await makeRetrievePolicy(store, bowEmbedFn)("small online authorizations within an hour followed by larger purchase", undefined, 2);
    // The R5 chunk must be among the seeds; its heading tags R5, which
    // card_testing cites, so the expansion must reach card_testing.
    const ids = result.data.chunks.map((c) => c.chunk_id);
    expect(ids).toContain("pc_0002");
    expect(result.data.permitted_actions).toEqual(
      expect.arrayContaining(["DECLINE_TRANSACTION", "STEP_UP_AUTH", "BLOCK_CARD"]),
    );
    expect(result.data.required_evidence).toContain("txn_velocity_small_online_auths");
  });

  it("expands across multiple patterns touched by different seed chunks", async () => {
    const store = seededStore();
    // Query mixing card-testing and out-of-region words; both patterns'
    // rule chunks can be seed chunks, so both patterns' actions appear.
    const result = await makeRetrievePolicy(store, bowEmbedFn)("card testing billing region purchase", undefined, 4);
    expect(result.data.permitted_actions).toEqual(
      expect.arrayContaining(["DECLINE_TRANSACTION", "STEP_UP_AUTH"]),
    );
  });

  it("envelope marks truncated when more candidates than k exist", async () => {
    const store = seededStore();
    const result = await makeRetrievePolicy(store, bowEmbedFn)("card testing purchase authorization", undefined, 1);
    expect(result.data.chunks.length).toBe(1);
    expect(result.truncated).toBe(true);
  });
});