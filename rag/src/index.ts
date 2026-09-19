/**
 * WS3 (`rag/`) public surface.
 *
 * Everything WS4+ and the ingestion CLI use. The three *contract* tools
 * WS3 owns (`retrieve_policy`, `retrieve_similar_cases`, `lookup_external`)
 * are exposed through `createRagRuntime()` with `contracts/src/tools.ts`'s
 * exact signatures; everything else WS3 adds (`context_builder`, ingestion,
 * memory write path) is internal-and-exported here, since `contracts/` is
 * frozen and defines no signature for it (PRD §11 names `context_builder`
 * but leaves its shape to WS3 -> `types.ts`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LookupExternal,
  RetrievePolicy,
  RetrieveSimilarCases,
} from "@hhgoa/contracts";
import { buildContextBundle, type ContextBuildInput } from "./contextBuilder.js";
import { embedBatch } from "./embeddings.js";
import { explainOverlap } from "./fingerprint.js";
import { getEntityCaseStats, writeCaseToMemory, type WriteCaseMemoryInput } from "./memory.js";
import { findPattern, PATTERNS } from "./patterns.js";
import {
  coerceFingerprint,
  makeRetrievePolicy,
  makeRetrieveSimilarCases,
  scorePolicyChunks,
  scoreSimilarCases,
  type EmbedFn,
} from "./retrieve.js";
import { LocalJsonVectorStore, type VectorStore } from "./store/vectorStore.js";
import type { CaseMemoryRecord, PolicyChunkRecord } from "./types.js";
import { ingestClosedCases } from "./ingestCases.js";
import { buildRawPolicyChunks, ingestPolicy } from "./ingestPolicy.js";
import { lookupExternal } from "./externalLookup.js";

export { chunkMarkdown, chunkProse } from "./chunk.js";
export { approxTokenCount } from "./tokenCount.js";
export {
  buildFingerprint,
  entityOverlapScore,
  explainOverlap,
  type FingerprintInput,
} from "./fingerprint.js";
export { makeRetrievePolicy, makeRetrieveSimilarCases } from "./retrieve.js";
export {
  buildContextBundle,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type ContextBuildInput,
  type ContextEvidenceItemInput,
  type ContextPatternInput,
  type ContextPolicyChunkInput,
  type ContextPriorCaseInput,
} from "./contextBuilder.js";
export {
  getEntityCaseStats,
  writeCaseToMemory,
  type EntityCaseStats,
  type WriteCaseMemoryInput,
} from "./memory.js";
export { ingestClosedCases, buildCaseSummaryText } from "./ingestCases.js";
export { buildRawPolicyChunks, ingestPolicy } from "./ingestPolicy.js";
export { PATTERNS, findPattern } from "./patterns.js";
export { lookupExternal } from "./externalLookup.js";
export {
  LocalJsonVectorStore,
  type VectorStore,
} from "./store/vectorStore.js";
export { embedText, embedBatch, cosineSimilarity, EMBEDDING_DIM } from "./embeddings.js";
export {
  loadClosedCases,
  loadCasePack,
  type ClosedCaseRow,
  type CasePackRow,
} from "./sources/closedCases.js";
export type {
  AmountBand,
  CaseFingerprint,
  CaseMemoryRecord,
  ContextBundle,
  ContextBundleItem,
  PatternRecord,
  PolicyChunkRecord,
  SourceDocKind,
} from "./types.js";

export interface RagRuntimeOptions {
  /** Directory for the local vector-store JSON files (default `<rag>/.data`). */
  dataDir?: string;
  /** Injection point for tests; defaults to the real local model via embedBatch. */
  embedFn?: EmbedFn;
}

export interface AgentBundleArgs {
  query: string;
  pattern_id?: string;
  k_policy_chunks: number;
  fingerprint: Record<string, unknown>;
  as_of: string;
  k_similar_cases: number;
  budget_tokens?: number;
  evidenceItems?: ContextBuildInput["evidenceItems"];
}

export interface RagRuntime {
  policyStore: VectorStore<PolicyChunkRecord>;
  caseStore: VectorStore<CaseMemoryRecord>;

  /** PRD §11 step 1+2: hybrid retrieval (vector seeds + graph expansion). */
  retrieve_policy: RetrievePolicy;
  /** PRD §11: cosine + entity-overlap with `as_of` filtering. */
  retrieve_similar_cases: RetrieveSimilarCases;
  /** PRD §8.4: static/mock enrichment, labelled external. */
  lookup_external: LookupExternal;

  /** Rank + trim into a provenance-tagged <= 6k-token bundle. */
  buildBundle(input: ContextBuildInput, budgetTokens?: number): ReturnType<typeof buildContextBundle>;
  /** One-shot retrieve -> rank -> trim for the agent (R4). */
  buildAgentBundle(args: AgentBundleArgs): Promise<ReturnType<typeof buildContextBundle>>;

  /** Memory write path (PRD §11) — fingerprinted, embedded, retrievable from `as_of`. */
  writeCaseToMemory(input: WriteCaseMemoryInput): Promise<CaseMemoryRecord>;
  getEntityCaseStats(
    entity: { type: "Customer" | "Card"; id: string },
    as_of: string,
  ): ReturnType<typeof getEntityCaseStats>;

  /** Idempotent: load the local stores from disk, or ingest + save them if missing. */
  ensureIngested(): Promise<void>;
}

const defaultEmbedFn: EmbedFn = async (texts) => embedBatch(texts);

function defaultDataDir(): string {
  // rag/src/index.ts -> rag/.data is 2 levels up from the source dir.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", ".data");
}

export function createRagRuntime(options: RagRuntimeOptions = {}): RagRuntime {
  const dataDir = options.dataDir ?? defaultDataDir();
  const embedFn: EmbedFn = options.embedFn ?? defaultEmbedFn;
  const policyStore = new LocalJsonVectorStore<PolicyChunkRecord>(
    path.join(dataDir, "policy-chunks.json"),
  );
  const caseStore = new LocalJsonVectorStore<CaseMemoryRecord>(
    path.join(dataDir, "case-memory.json"),
  );
  const retrievePolicy = makeRetrievePolicy(policyStore, embedFn);
  const retrieveSimilarCases = makeRetrieveSimilarCases(caseStore, embedFn);

  const runtime: RagRuntime = {
    policyStore,
    caseStore,

    /** PRD §11 step 1+2: hybrid retrieval (vector seeds + graph expansion). */
    retrieve_policy: retrievePolicy,
    /** PRD §11: cosine + entity-overlap with `as_of` filtering. */
    retrieve_similar_cases: retrieveSimilarCases,
    /** PRD §8.4: static/mock enrichment, labelled external. */
    lookup_external: lookupExternal,

    buildBundle: (input, budgetTokens) => buildContextBundle(input, budgetTokens),

    buildAgentBundle: async (args) => {
      const chunks = await scorePolicyChunks(
        policyStore,
        embedFn,
        args.query,
        args.pattern_id,
        args.k_policy_chunks,
      );
      const cases = await scoreSimilarCases(
        caseStore,
        embedFn,
        args.fingerprint,
        args.as_of,
      );
      const queryFingerprint = coerceFingerprint(args.fingerprint);
      const pattern = args.pattern_id ? findPattern(args.pattern_id) : undefined;
      return buildContextBundle(
        {
          query: args.query,
          policyChunks: chunks.map((c) => ({
            id: c.record.chunk_id,
            text: c.record.text,
            source_doc: c.record.source_doc,
            heading_path: c.record.heading_path,
            pattern_id: c.record.pattern_id,
            score: c.score,
          })),
          priorCases: cases.slice(0, args.k_similar_cases).map((c) => ({
            id: c.record.case_id,
            summary_text: c.record.summary_text,
            outcome: c.record.outcome as "confirmed_fraud" | "cleared",
            score: c.score,
            overlap_reason: explainOverlap(queryFingerprint, c.record.fingerprint),
          })),
          patterns: pattern ? [pattern] : PATTERNS,
          evidenceItems: args.evidenceItems,
        },
        args.budget_tokens,
      );
    },

    writeCaseToMemory: async (input) => writeCaseToMemory(caseStore, embedFn, input),

    getEntityCaseStats: (entity, as_of) => getEntityCaseStats(caseStore, entity, as_of),

    ensureIngested: async () => {
      policyStore.load();
      caseStore.load();
      if (policyStore.all().length > 0 && caseStore.all().length > 0) return;

      const policies = await ingestPolicy(embedFn);
      for (const p of policies) policyStore.upsert(p.chunk_id, p.embedding, p);
      policyStore.save();

      const cases = await ingestClosedCases(embedFn);
      for (const c of cases) caseStore.upsert(c.case_id, c.embedding, c);
      caseStore.save();
    },
  };

  return runtime;
}