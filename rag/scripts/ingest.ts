/**
 * WS3 ingestion CLI. Builds the local vector-store files under `rag/.data/`
 * (policy/pattern/regulatory chunks + closed-case fingerprinted memory)
 * using the real local embedding model. Run from the repo root:
 *
 *   pnpm --filter @hhgoa/rag run ingest
 *   pnpm --filter @hhgoa/rag run ingest -- --max-cases 200   # smoke run
 *   pnpm --filter @hhgoa/rag run ingest -- --no-signals      # skip the 700MB CSV join
 *
 * The outputs are derived data (gitignored, see rag/.gitignore) — the
 * runtime re-ingests automatically if they're missing, so this is only
 * needed to warm the cache / see progress.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedBatch } from "../src/embeddings.js";
import { ingestClosedCases } from "../src/ingestCases.js";
import { buildRawPolicyChunks, ingestPolicy } from "../src/ingestPolicy.js";
import { LocalJsonVectorStore } from "../src/store/vectorStore.js";

function dataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", ".data");
}

const args = process.argv.slice(2);
const maxCasesArg = args.find((a) => a.startsWith("--max-cases="));
const maxCases = maxCasesArg ? Number(maxCasesArg.split("=")[1]) : undefined;
const withSignals = !args.includes("--no-signals");

const started = Date.now();
console.log(`embedding model: Xenova/bge-small-en-v1.5 (loaded on first embed)`);
console.log(`closed-case signals join: ${withSignals ? "on" : "off"}`);
if (maxCases) console.log(`closed-case limit: ${maxCases}`);

const policyStore = new LocalJsonVectorStore(path.join(dataDir(), "policy-chunks.json"));
const caseStore = new LocalJsonVectorStore(path.join(dataDir(), "case-memory.json"));

const rawChunks = buildRawPolicyChunks();
console.log(`\npolicy/pattern/regulatory source chunks: ${rawChunks.length}`);

const policyRecords = await ingestPolicy(async (texts) => embedBatch(texts, (d, t) => {
  if (d % 5 === 0 || d === t) process.stdout.write(`\r  policy chunks embedded: ${d}/${t}`);
}));
console.log();
policyRecords.forEach((r) => policyStore.upsert(r.chunk_id, r.embedding, r));
policyStore.save();
console.log(`policy chunks stored: ${policyStore.all().length}`);

const caseRecords = await ingestClosedCases(
  async (texts, onProgress) => embedBatch(texts, onProgress),
  {
    withTransactionSignals: withSignals,
    onProgress: (d, t) => process.stdout.write(`\r  case summaries embedded: ${d}/${t}`),
    limit: maxCases,
  },
);
console.log();
for (const c of caseRecords) caseStore.upsert(c.case_id, c.embedding, c);
caseStore.save();
console.log(`closed-case memory records stored: ${caseStore.all().length}`);

const fraudCases = caseRecords.filter((c) => c.outcome === "confirmed_fraud").length;
const withPattern = caseRecords.filter((c) => c.pattern !== "none").length;
console.log(`  confirmed_fraud: ${fraudCases}, cleared: ${caseRecords.length - fraudCases}, pattern != none: ${withPattern}`);
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`store files: ${dataDir()}/`);