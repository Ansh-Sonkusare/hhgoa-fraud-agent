/**
 * Pushes the RAG vector index into TigerGraph: every policy chunk becomes a
 * `PolicyChunk` vertex with its embedding, and every closed case's embedding
 * is written onto its existing `FraudCase` vertex (never creating one). After
 * this, RAG_VECTOR_BACKEND=tigergraph retrieval scores through the graph's
 * `vector_search` query. Run from the repo root:
 *
 *   pnpm --filter @hhgoa/rag sync-graph
 *
 * Idempotent: re-running overwrites the same attributes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalJsonVectorStore } from "../src/store/vectorStore.js";
import { TigerGraphVectorIndex, tigerGraphConnectionFromEnv } from "../src/store/tigergraphIndex.js";
import type { CaseMemoryRecord, PolicyChunkRecord } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, "..", "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const dataDir = path.join(here, "..", ".data");
const chunks = new LocalJsonVectorStore<PolicyChunkRecord>(path.join(dataDir, "policy-chunks.json"));
const cases = new LocalJsonVectorStore<CaseMemoryRecord>(path.join(dataDir, "case-memory.json"));
chunks.load();
cases.load();
if (chunks.all().length === 0 || cases.all().length === 0) {
  throw new Error("rag/.data is empty; run `pnpm --filter @hhgoa/rag ingest` first");
}

const index = new TigerGraphVectorIndex(tigerGraphConnectionFromEnv());
const t0 = Date.now();
const nChunks = await index.syncChunks(chunks.all());
process.stdout.write(`PolicyChunk: ${nChunks}/${chunks.all().length} upserted\n`);
const { accepted, missing } = await index.syncCases(cases.all());
process.stdout.write(`FraudCase.embedding: ${accepted}/${cases.all().length} written\n`);
if (missing.length > 0) {
  process.stdout.write(`no FraudCase vertex for ${missing.length} record(s): ${missing.slice(0, 10).join(", ")}\n`);
  process.exitCode = 1;
}
process.stdout.write(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
