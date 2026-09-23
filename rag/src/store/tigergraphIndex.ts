/**
 * TigerGraph as the vector index behind RAG retrieval.
 *
 * Policy chunks live in the graph as `PolicyChunk` vertices and closed cases as
 * `FraudCase` vertices, each with an `embedding LIST<DOUBLE>` (graph/schema.gsql).
 * Retrieval scores the query embedding against them with the installed
 * `vector_search` query (gsql/queries/vector_search.gsql), which computes the
 * same cosine as `cosineSimilarity` in ../embeddings.ts.
 *
 * The local JSON stores stay the source of record text and metadata; the
 * graph supplies the similarity scores. Case eligibility (visible_from <=
 * as_of, resolved outcome) stays in retrieve.ts, which already owns and tests
 * it: agent-written memory records are keyed by the run's case id while their
 * graph vertex is `GRAPH-<case id>` with its own closed_at, so the graph is
 * asked for every case's score and the caller filters. `graphIdFor` is the one
 * place that mapping lives.
 */
import type { CaseMemoryRecord, PolicyChunkRecord } from "../types.js";

export interface GraphVectorScores {
  /** Cosine of the query against every PolicyChunk in the graph, by chunk id. */
  scoreChunks(queryEmbedding: number[]): Promise<Map<string, number>>;
  /** Cosine of the query against every FraudCase that has an embedding, by graph id. */
  scoreCases(queryEmbedding: number[]): Promise<Map<string, number>>;
}

/** The FraudCase vertex id that holds a memory record's embedding. */
export function graphIdFor(record: Pick<CaseMemoryRecord, "case_id" | "source">): string {
  return record.source === "agent_written" ? `GRAPH-${record.case_id}` : record.case_id;
}

export interface TigerGraphConnection {
  /** e.g. http://localhost:9000 (REST++ base). */
  baseUrl: string;
  graph: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export function tigerGraphConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): TigerGraphConnection {
  const host = env["TIGERGRAPH_HOST"];
  if (!host) throw new Error("RAG_VECTOR_BACKEND=tigergraph needs TIGERGRAPH_HOST");
  const withPort = /:\d+\/?$/.test(host) ? host : `${host.replace(/\/$/, "")}:${env["TIGERGRAPH_REST_PORT"] ?? "9000"}`;
  return {
    baseUrl: withPort.replace(/\/$/, ""),
    graph: env["TIGERGRAPH_GRAPH_NAME"] ?? "hhgoa_fraud",
    username: env["TIGERGRAPH_USERNAME"] ?? "tigergraph",
    password: env["TIGERGRAPH_PASSWORD"] ?? "",
  };
}

interface VectorSearchResult {
  chunks: { id: string; score: number }[];
  cases: { id: string; score: number }[];
  query_dim: number;
}

/** Larger than any population the graph holds (5,565 closed cases). */
const SCAN_ALL = 1_000_000;

export class TigerGraphVectorIndex implements GraphVectorScores {
  constructor(private readonly conn: TigerGraphConnection) {}

  private get auth(): string {
    return `Basic ${Buffer.from(`${this.conn.username}:${this.conn.password}`).toString("base64")}`;
  }

  private async vectorSearch(params: Record<string, unknown>): Promise<VectorSearchResult> {
    const res = await fetch(`${this.conn.baseUrl}/query/${this.conn.graph}/vector_search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.auth, "GSQL-TIMEOUT": "120000" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.conn.timeoutMs ?? 120_000),
    });
    const body = (await res.json()) as { error?: boolean; message?: string; results?: Record<string, unknown>[] };
    if (!res.ok || body.error) throw new Error(`vector_search: ${body.message ?? `HTTP ${res.status}`}`);
    const merged = Object.assign({}, ...(body.results ?? [])) as Partial<VectorSearchResult>;
    return { chunks: merged.chunks ?? [], cases: merged.cases ?? [], query_dim: merged.query_dim ?? 0 };
  }

  private async scoreAll(vertexType: "PolicyChunk" | "FraudCase", queryEmbedding: number[]): Promise<Map<string, number>> {
    const r = await this.vectorSearch({
      vertex_type: vertexType,
      query_id: "",
      k: SCAN_ALL,
      pattern_id: "",
      as_of: "",
      apply_as_of: false,
      outcome: "",
      qvec: queryEmbedding,
      scores_only: true,
    });
    if (r.query_dim !== queryEmbedding.length) {
      throw new Error(`vector_search: graph read a ${r.query_dim}-dim query, sent ${queryEmbedding.length}`);
    }
    const rows = vertexType === "PolicyChunk" ? r.chunks : r.cases;
    return new Map(rows.map((row) => [row.id, row.score]));
  }

  scoreChunks(queryEmbedding: number[]): Promise<Map<string, number>> {
    return this.scoreAll("PolicyChunk", queryEmbedding);
  }

  scoreCases(queryEmbedding: number[]): Promise<Map<string, number>> {
    return this.scoreAll("FraudCase", queryEmbedding);
  }

  /** REST++ upsert (v2 attribute format). `mustExist` refuses to create vertices. */
  private async upsert(vertexType: string, rows: Record<string, Record<string, unknown>>, mustExist: boolean): Promise<number> {
    const vertices: Record<string, Record<string, { value: unknown }>> = {};
    for (const [id, attrs] of Object.entries(rows)) {
      vertices[id] = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v }]));
    }
    const qs = mustExist ? "?vertex_must_exist=true" : "";
    const res = await fetch(`${this.conn.baseUrl}/graph/${this.conn.graph}${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.auth },
      body: JSON.stringify({ vertices: { [vertexType]: vertices } }),
      signal: AbortSignal.timeout(this.conn.timeoutMs ?? 120_000),
    });
    const body = (await res.json()) as { error?: boolean; message?: string; results?: { accepted_vertices?: number }[] };
    if (!res.ok || body.error) throw new Error(`upsert ${vertexType}: ${body.message ?? `HTTP ${res.status}`}`);
    return body.results?.[0]?.accepted_vertices ?? 0;
  }

  /** Writes every policy chunk as a PolicyChunk vertex (created if absent). */
  async syncChunks(chunks: readonly PolicyChunkRecord[]): Promise<number> {
    const rows: Record<string, Record<string, unknown>> = {};
    for (const c of chunks) {
      rows[c.chunk_id] = { text: c.text, source_doc: c.source_doc, pattern_id: c.pattern_id ?? "", embedding: c.embedding };
    }
    return this.upsert("PolicyChunk", rows, false);
  }

  /**
   * Writes case embeddings onto their existing FraudCase vertices. Never
   * creates a case: a memory record whose vertex is missing is reported, not
   * invented.
   */
  async syncCases(cases: readonly CaseMemoryRecord[], batchSize = 250): Promise<{ accepted: number; missing: string[] }> {
    let accepted = 0;
    const missing: string[] = [];
    for (let i = 0; i < cases.length; i += batchSize) {
      const batch = cases.slice(i, i + batchSize);
      const rows: Record<string, Record<string, unknown>> = {};
      for (const c of batch) rows[graphIdFor(c)] = { embedding: c.embedding };
      const n = await this.upsert("FraudCase", rows, true);
      accepted += n;
      if (n < batch.length) missing.push(...(await this.missingCases(batch)));
    }
    return { accepted, missing };
  }

  private async missingCases(batch: readonly CaseMemoryRecord[]): Promise<string[]> {
    const present = await this.scoreCases(batch[0]!.embedding);
    return batch.map(graphIdFor).filter((id) => !present.has(id));
  }
}
