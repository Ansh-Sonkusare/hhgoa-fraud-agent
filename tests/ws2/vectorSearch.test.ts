/**
 * tests/ws2/vectorSearch.test.ts -- live tests for the vector_search and
 * get_pattern_profile installed queries (docs/REQUESTS.md "2026-09-18 - WS3
 * asks WS1", items 4 / 4b).
 *
 * vector_search is the graph half of WS3's RAG store. Its ranking contract is
 * pinned to rag/src/store/vectorStore.ts + rag/src/embeddings.ts: score =
 * true cosine dot/(||a||.||b||); unscorable rows (no embedding, dimension
 * mismatch) are left out. The query vector comes from the `qvec` parameter,
 * or from the `embedding` of a seeded vertex when qvec is empty. Because the
 * graph has no PolicyChunk rows and the test needs byte-exact embeddings and
 * case timestamps, this test upserts its own synthetic rows over the REST
 * standard API (`POST /graph/hhgoa_fraud`, v2 attribute format) and removes
 * them afterwards. Embedded real cases (CC-*) legitimately appear as score-0
 * members of the top-k heap, so assertions target the synthetic ids and
 * scores, never total lengths.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { runQuery } from "./helpers.js";

const HOST = process.env.TIGERGRAPH_REST_HOST ?? "localhost";
const PORT = process.env.TIGERGRAPH_REST_PORT ?? "9000";
const USER = process.env.TIGERGRAPH_USERNAME ?? "tigergraph";
const PASS = process.env.TIGERGRAPH_PASSWORD ?? "tigergraph";
const GRAPH = "hhgoa_fraud";
const BASE = `http://${HOST}:${PORT}`;
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;

const DIM = 384;
const basis = (lo: number, hi: number): number[] =>
  Array.from({ length: DIM }, (_, j) => (j >= lo && j < hi ? 1 / Math.sqrt(hi - lo) : 0));

// Unit-norm basis blocks. Cosine between identical vectors is 1.0; between
// disjoint blocks it is 0.0 -- no approximate math involved.
const V0 = basis(0, 64);
const V1 = basis(64, 128);
const V2 = basis(128, 192);

const AS_OF = "2026-09-01 00:00:00";

// Synthetic rows; ids prefixed VEC_ so they never collide with CC-* / disc_*.
// chunks: pa & pc share vector+pattern, pb and pd are orthogonal / other.
const CHUNK_ROWS: { id: string; text: string; source_doc: string; pattern_id: string; embedding: number[] }[] = [
  { id: "VEC_PA", text: "charging pattern A", source_doc: "policy.md", pattern_id: "det_card_testing", embedding: V0 },
  { id: "VEC_PB", text: "account takeover", source_doc: "policy.md", pattern_id: "det_account_takeover", embedding: V1 },
  { id: "VEC_PC", text: "repeated small charges", source_doc: "policy.md", pattern_id: "det_card_testing", embedding: V0 },
  { id: "VEC_PD", text: "out of region", source_doc: "policy.md", pattern_id: "det_out_of_region", embedding: V2 },
];
// cases: F1/F2 closed before as_of, F4 closed after, F3 still open (upserted
// without closed_at, which the graph stores as the DATETIME epoch default --
// exactly how WS1's open cases read back, see vector_search.gsql header).
const CASE_BASE = {
  status: "closed",
  pattern: "det_card_testing",
  opened_at: "2026-09-01 00:00:00",
  exposure_usd: 0,
};
const CASE_ROWS: { id: string; outcome: string; summary: string; closed_at: string | null; embedding: number[] }[] = [
  { id: "VEC_F1", outcome: "confirmed_fraud", summary: "old confirmed", closed_at: "2026-08-01 00:00:00", embedding: V0 },
  { id: "VEC_F2", outcome: "cleared", summary: "old cleared", closed_at: "2026-08-15 00:00:00", embedding: V0 },
  { id: "VEC_F3", outcome: "in_review", summary: "open case", closed_at: null, embedding: V0 },
  { id: "VEC_F4", outcome: "confirmed_fraud", summary: "future confirmed", closed_at: "2026-10-01 00:00:00", embedding: V0 },
];

interface CaseHit {
  id: string;
  outcome: string;
  closed_at: string;
  score: number;
}
interface ChunkHit {
  id: string;
  text: string;
  pattern_id: string;
  score: number;
}

async function restJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (body.error) throw new Error(`REST ${url}: ${body.message}`);
  return body;
}

// v2 upsert: every attribute wrapped in {"value": ...}; omitting an attribute
// leaves the stored default (so an open case's closed_at stays epoch).
async function upsertVertex(type: string, id: string, attrs: Record<string, unknown>): Promise<void> {
  const wrapped: Record<string, { value: unknown }> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) wrapped[k] = { value: v };
  await restJson(`${BASE}/graph/${GRAPH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH, "GSQL-TIMEOUT": "300000" },
    body: JSON.stringify({ vertices: { [type]: { [id]: wrapped } } }),
  });
}

async function deleteVertex(type: string, id: string): Promise<void> {
  await restJson(`${BASE}/graph/${GRAPH}/vertices/${type}/${id}`, { method: "DELETE", headers: { Authorization: AUTH } });
}

async function vectorSearch(params: {
  vertex_type: string;
  query_id: string;
  k?: number;
  pattern_id?: string;
  as_of?: string;
  apply_as_of?: boolean;
  outcome?: string;
  qvec?: number[];
  scores_only?: boolean;
}): Promise<{ chunks: ChunkHit[]; cases: CaseHit[]; query_dim: number; query_src: number }> {
  return runQuery("vector_search", {
    vertex_type: params.vertex_type,
    query_id: params.query_id,
    k: params.k ?? 10,
    pattern_id: params.pattern_id ?? "",
    as_of: params.as_of ?? "",
    apply_as_of: params.apply_as_of ?? false,
    outcome: params.outcome ?? "",
    qvec: params.qvec ?? [],
    scores_only: params.scores_only ?? false,
  });
}

beforeAll(async () => {
  for (const c of CHUNK_ROWS) {
    await upsertVertex("PolicyChunk", c.id, {
      text: c.text,
      source_doc: c.source_doc,
      pattern_id: c.pattern_id,
      embedding: c.embedding,
    });
  }
  for (const c of CASE_ROWS) {
    await upsertVertex("FraudCase", c.id, {
      ...CASE_BASE,
      verdict: c.outcome === "cleared" ? "cleared" : "fraud",
      outcome: c.outcome,
      summary: c.summary,
      closed_at: c.closed_at ?? undefined,
      embedding: c.embedding,
    });
  }
});

afterAll(async () => {
  for (const c of CHUNK_ROWS) await deleteVertex("PolicyChunk", c.id);
  for (const c of CASE_ROWS) await deleteVertex("FraudCase", c.id);
});

describe("vector_search: PolicyChunk branch", () => {
  it("ranks by cosine over the seeded query vector (1.0 self, 0.0 orthogonal)", async () => {
    // k covers every chunk: once the real policy chunks are synced into the
    // graph, the orthogonal synthetic rows (score 0) rank below them.
    const r = await vectorSearch({ vertex_type: "PolicyChunk", query_id: "VEC_PA", k: 1000 });
    const pa = r.chunks.find((c) => c.id === "VEC_PA");
    const pc = r.chunks.find((c) => c.id === "VEC_PC");
    const pb = r.chunks.find((c) => c.id === "VEC_PB");
    const pd = r.chunks.find((c) => c.id === "VEC_PD");
    expect(r.query_dim).toBe(DIM);
    expect(r.query_src).toBe(1);
    expect(pa?.score).toBeCloseTo(1, 5);
    expect(pc?.score).toBeCloseTo(1, 5);
    expect(pb?.score).toBeCloseTo(0, 5);
    expect(pd?.score).toBeCloseTo(0, 5);
  });

  it("narrows to an exact pattern_id when given", async () => {
    const r = await vectorSearch({ vertex_type: "PolicyChunk", query_id: "VEC_PA", k: 10, pattern_id: "det_card_testing" });
    const ids = r.chunks.map((c) => c.id);
    expect(ids).toContain("VEC_PA");
    expect(ids).toContain("VEC_PC");
    expect(ids).not.toContain("VEC_PB");
    expect(ids).not.toContain("VEC_PD");
    expect(r.chunks.every((c) => c.pattern_id === "det_card_testing")).toBe(true);
  });

  it("leaves unscorable rows out: a missing seed yields query_dim 0 and no hits", async () => {
    // Rows are scored only when both vectors are non-empty, non-zero and the
    // same dimension; anything else is "not in the index", not "dissimilar".
    const r = await vectorSearch({ vertex_type: "PolicyChunk", query_id: "VEC_DOES_NOT_EXIST", k: 10 });
    expect(r.query_dim).toBe(0);
    expect(r.chunks).toEqual([]);
  });

  it("takes the query vector from the qvec parameter, and scores_only drops the text", async () => {
    const r = await vectorSearch({ vertex_type: "PolicyChunk", query_id: "", k: 1000, qvec: V1, scores_only: true });
    expect(r.query_dim).toBe(DIM);
    expect(r.query_src).toBe(0);
    expect(r.chunks.find((c) => c.id === "VEC_PB")?.score).toBeCloseTo(1, 5);
    expect(r.chunks.find((c) => c.id === "VEC_PA")?.score).toBeCloseTo(0, 5);
    expect(r.chunks.every((c) => c.text === "")).toBe(true);
  });

  it("computes true cosine, not a raw dot product, for a non-unit query", async () => {
    const r = await vectorSearch({ vertex_type: "PolicyChunk", query_id: "", k: 1000, qvec: V0.map((x) => 3 * x) });
    expect(r.chunks.find((c) => c.id === "VEC_PA")?.score).toBeCloseTo(1, 5);
  });
});

describe("vector_search: FraudCase branch (apply_as_of / visible_from equivalence)", () => {
  it("apply_as_of=true keeps only cases closed strictly after epoch and <= as_of", async () => {
    const r = await vectorSearch({
      vertex_type: "FraudCase",
      query_id: "VEC_F1",
      k: 10,
      as_of: AS_OF,
      apply_as_of: true,
    });
    const ids = r.cases.map((c) => c.id);
    // F1 and F2 are closed before AS_OF at score 1.0.
    expect(ids).toContain("VEC_F1");
    expect(ids).toContain("VEC_F2");
    expect(r.cases.find((c) => c.id === "VEC_F1")?.score).toBeCloseTo(1, 5);
    expect(r.cases.find((c) => c.id === "VEC_F2")?.score).toBeCloseTo(1, 5);
    // F3 (open, epoch closed_at) and F4 (closed after as_of) must be absent.
    expect(ids).not.toContain("VEC_F3");
    expect(ids).not.toContain("VEC_F4");
    // Every returned case (including real CC-* rows) must have closed <= AS_OF.
    for (const c of r.cases) expect(c.closed_at <= AS_OF).toBe(true);
  });

  it("outcome narrows eligibility to confirmed_fraud", async () => {
    const r = await vectorSearch({
      vertex_type: "FraudCase",
      query_id: "VEC_F1",
      k: 10,
      as_of: AS_OF,
      apply_as_of: true,
      outcome: "confirmed_fraud",
    });
    const ids = r.cases.map((c) => c.id);
    expect(ids).toContain("VEC_F1");
    expect(ids).not.toContain("VEC_F2");
    expect(r.cases.every((c) => c.outcome === "confirmed_fraud")).toBe(true);
  });

  it("a case with no embedding is not returned; qvec scores the rest", async () => {
    await upsertVertex("FraudCase", "VEC_F5", { ...CASE_BASE, verdict: "fraud", outcome: "confirmed_fraud", summary: "no vector", closed_at: "2026-08-01 00:00:00" });
    try {
      const r = await vectorSearch({ vertex_type: "FraudCase", query_id: "", k: 20, qvec: V0 });
      const ids = r.cases.map((c) => c.id);
      expect(ids).toContain("VEC_F1");
      expect(ids).not.toContain("VEC_F5");
    } finally {
      await deleteVertex("FraudCase", "VEC_F5");
    }
  });

  it("apply_as_of=false scans every case regardless of closed_at", async () => {
    const r = await vectorSearch({ vertex_type: "FraudCase", query_id: "VEC_F1", k: 20, apply_as_of: false });
    const ids = r.cases.map((c) => c.id);
    for (const c of CASE_ROWS) expect(ids).toContain(c.id);
  });
});

describe("get_pattern_profile", () => {
  it("returns found=0 and empty lists for an unknown pattern", async () => {
    const r = await runQuery<{
      found: number;
      name: string[];
      kind: string[];
      description: string[];
      required_evidence: string[];
      required_evidence_names: string[];
    }>("get_pattern_profile", { pattern_id: "does_not_exist" });
    expect(r.found).toBe(0);
    expect(r.name).toEqual([]);
    expect(r.kind).toEqual([]);
    expect(r.required_evidence).toEqual([]);
  });

  it("reads a discovered Pattern vertex's own fields", async () => {
    // Discovered patterns (disc_*) are the only Pattern vertices the graph
    // carries (det_* records live in rag/src/patterns.ts, not the graph) --
    // fetch one live so the test never hard-codes a derived id.
    const list = await restJson(`${BASE}/graph/${GRAPH}/vertices/Pattern?limit=1`, {
      headers: { Authorization: AUTH },
    });
    const id = list?.results?.[0]?.v_id as string | undefined;
    expect(typeof id).toBe("string");
    const r = await runQuery<{ found: number; name: string[]; kind: string[]; description: string[] }>(
      "get_pattern_profile",
      { pattern_id: id! },
    );
    expect(r.found).toBe(1);
    expect(r.name[0]?.length ?? 0).toBeGreaterThan(0);
    expect(r.kind[0]).toBe("discovered");
    expect(typeof r.description[0]).toBe("string");
  });
});