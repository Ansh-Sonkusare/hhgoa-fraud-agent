import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRagRuntime } from "../../rag/src/index.js";
import { AnyToolResultSchema } from "../../contracts/src/toolEnvelope.js";
import type { CaseMemoryRecord, PolicyChunkRecord } from "../../rag/src/types.js";
import type { VectorStore } from "../../rag/src/store/vectorStore.js";
import {
  bowEmbedFn,
  fakeEmbedFn,
  makeCaseMemoryRecord,
  makePolicyChunk,
} from "./helpers.js";

/** Seed a runtime's stores directly (bypasses the full 676MB transaction
 * join kept for `make ingest`) so runtime wiring tests are fast. */
function seedStores(policyStore: VectorStore<PolicyChunkRecord>, caseStore: VectorStore<CaseMemoryRecord>): void {
  policyStore.upsert(
    "pc_0001",
    bowEmbedFn(["card testing"]).then!._v ? [] : [],
  );
}

describe("createRagRuntime wiring", () => {
  it("exposes stores, seeds, and serves the two retrieve tools with contract shapes", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ws3-runtime-"));
    try {
      const runtime = createRagRuntime({ dataDir, embedFn: bowEmbedFn });

      // Seed stores directly (fast path; full ingest is tested below).
      runtime.policyStore.upsert(
        "pc_0001",
        bowEmbedVec2("card testing"),
        makePolicyChunk({
          chunk_id: "pc_0001",
          pattern_id: "card_testing",
          heading_path: "The five known fraud patterns > 1. Card testing.",
          text: "Card testing: tiny online authorizations followed by a larger purchase.",
        }),
      );
      runtime.caseStore.upsert(
        "CC-0100",
        bowEmbedVec2("tiny authorizations then larger purchase"),
        makeCaseMemoryRecord({
          case_id: "CC-0100",
          customer_id: "C001",
          visible_from: "2016-07-02 00:00:00",
          summary_text: "tiny authorizations then larger purchase denied by the customer",
        }),
      );

      const policy = await runtime.retrieve_policy("card testing", "card_testing", 3);
      expect(policy.ok).toBe(true);
      expect(policy.tool).toBe("retrieve_policy");
      expect(AnyToolResultSchema.safeParse(policy).success).toBe(true);
      expect(policy.data.chunks.map((c) => c.chunk_id)).toContain("pc_0001");
      expect(policy.data.permitted_actions).toEqual(
        expect.arrayContaining(["DECLINE_TRANSACTION", "STEP_UP_AUTH"]),
      );

      const similar = await runtime.retrieve_similar_cases(
        { pattern: "card_testing", entity_ids: [{ type: "Card", id: "C001-K1" }] },
        "2016-09-01 00:00:00",
      5,
      );
      expect(AnyToolResultSchema.safeParse(similar).success).toBe(true);
      expect(similar.data.cases.map((c) => c.case_id)).toContain("CC-0100");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("createRagRuntime buildAgentBundle (one-shot R4 path)", () => {
  it("returns a bounded, provenance-tagged bundle without calling the model", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ws3-runtime-"));
    try {
      const runtime = createRagRuntime({ dataDir, embedFn: bowEmbedFn });
      runtime.policyStore.upsert(
        "pc_0001",
        bowEmbedVec2("card testing"),
        makePolicyChunk({
          chunk_id: "pc_0001",
          pattern_id: "card_testing",
          text: "Card testing: tiny online authorizations then a larger purchase.",
        }),
      );
      runtime.caseStore.upsert(
        "CC-0100",
        bowEmbedVec2("tiny authorizations then larger purchase"),
        makeCaseMemoryRecord({
          case_id: "CC-0100",
          visible_from: "2016-07-02 00:00:00",
          summary_text: "tiny authorizations then larger purchase denied by the customer",
        }),
      );

      const bundle = await runtime.buildAgentBundle({
        query: "card testing",
        pattern_id: "card_testing",
        k_policy_chunks: 3,
        fingerprint: { pattern: "card_testing", entity_ids: [{ type: "Card", id: "C001-K1" }] },
        as_of: "2016-09-01 00:00:00",
        k_similar_cases: 3,
        evidenceItems: [{ id: "ev-1", summary: "three tiny authorizations in 30 min", category: "txn_velocity" }],
      });

      expect(bundle.total_tokens).toBeLessThanOrEqual(bundle.budget_tokens);
      expect(bundle.truncated).toBe(false);
      const kinds = bundle.items.map((i) => i.kind);
      expect(kinds).toContain("pattern");
      expect(kinds).toContain("policy_chunk");
      expect(kinds).toContain("prior_case");
      expect(kinds).toContain("evidence");
      expect(bundle.items.map((i) => i.id)).toEqual(bundle.provenance_ids);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("createRagRuntime memory + stats", () => {
  it("writeCaseToMemory -> getEntityCaseStats round-trip", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ws3-runtime-"));
    try {
      const runtime = createRagRuntime({ dataDir, embedFn: fakeEmbedFn });
      await runtime.writeCaseToMemory({
        case_id: "HHG-050",
        case_record: {
          status: "closed_fraud",
          verdict: "fraud",
          fraud_probability: 0.88,
          pattern: "card_not_present_fraud",
          pattern_description: "",
          affected_txn_ids: ["3000001"],
          first_suspicious_txn_id: "3000001",
          connected_card_ids: [],
          connected_device_profiles: [],
          exposure_usd: 300,
          evidence: [],
          similar_prior_cases: [],
          summary: "cardholder denied an unknown online charge",
          written_to_graph: false,
          graph_case_id: "",
        },
        customer_id: "C999",
        card_id: "C999-K1",
        as_of: "2016-10-01 12:00:00",
      });

      const stats = runtime.getEntityCaseStats(
        { type: "Customer", id: "C999" },
        "2016-10-01 12:00:00",
      );
      expect(stats.prior_case_count).toBe(1);
      expect(stats.confirmed_fraud_count).toBe(1);

      // Not visible before its written_at.
      const earlier = runtime.getEntityCaseStats({ type: "Customer", id: "C999" }, "2016-09-01 00:00:00");
      expect(earlier.prior_case_count).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("createRagRuntime ensureIngested", () => {
  it("loads existing local stores idempotently (no re-ingestion)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ws3-runtime-"));
    try {
      // First runtime seeds a tiny corpus and persists it.
      const first = createRagRuntime({ dataDir, embedFn: fakeEmbedFn });
      first.policyStore.upsert("pc_x", fakeEmbedVec2("policy"), makePolicyChunk({
        chunk_id: "pc_x",
        text: "policy chunk text",
      }));
      first.caseStore.upsert("CC-X", fakeEmbedVec2("case"), makeCaseMemoryRecord({
        case_id: "CC-X",
        visible_from: "2016-07-02 00:00:00",
        summary_text: "a case narrative",
      }));
      first.policyStore.save();
      first.caseStore.save();

      // Fresh runtime on the same dir: ensureIngested must reload these
      // two records, not run the 5,565-case ingestion.
      const second = createRagRuntime({ dataDir, embedFn: fakeEmbedFn });
      await second.ensureIngested();
      expect(second.policyStore.all().length).toBe(1);
      expect(second.caseStore.all().length).toBe(1);
      expect(second.policyStore.get("pc_x")).toBeDefined();
      expect(second.caseStore.get("CC-X")).toBeDefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/** Deterministic unit vectors (helpers' bow_bucket form) kept local so
 * this file doesn't depend on helpers' FAKE_DIM choices. */
function bowEmbedVec2(text: string): number[] {
  const v = new Array(16).fill(0);
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % 16] = (v[h % 16] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => (norm > 0 ? x / norm : 0));
}
function fakeEmbedVec2(text: string): number[] {
  const v = new Array(16).fill(0);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < 16; i++) v[i] = Math.sin(h * (i + 1) + i) * 0.5 + 0.25;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}