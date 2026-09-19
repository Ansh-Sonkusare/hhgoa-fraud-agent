/**
 * Test helpers for tests/ws3.
 *
 * Everything embeds through the *injected* `embedFn` parameter of the rag
 * modules — tests never load the real @xenova/transformers model (no
 * network, no 130MB download). `fakeEmbedVec` is a deterministic hash of
 * the text into a unit vector, so two equal strings embed identically
 * (cosine 1) and distinct policy/case texts get stable, distinct-ish
 * vectors for ranking tests.
 */
import { cosineSimilarity, embedBatch } from "../../rag/src/embeddings.js";
import { approxTokenCount } from "../../rag/src/tokenCount.js";
import type { CaseMemoryRecord, PolicyChunkRecord } from "../../rag/src/types.js";

export const FAKE_DIM = 32;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic unit vector derived from the text. */
export function fakeEmbedVec(text: string): number[] {
  const v = new Array(FAKE_DIM).fill(0);
  const h = hashStr(text);
  for (let i = 0; i < FAKE_DIM; i++) {
    v[i] = Math.sin(h * (i + 1) + i) * 0.5 + 0.25;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** EmbedFn-compatible; also accepts the optional onProgress extra arg. */
export const fakeEmbedFn = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(texts.map(fakeEmbedVec));

/**
 * Bag-of-words unit vector: each word buckets into one coordinate, so
 * cosine similarity between two texts is a true *word-overlap* measure.
 * Deterministic and cheap, and it gives retrieval tests the property the
 * hash-based `fakeEmbedVec` can't: texts sharing the query's words rank
 * above unrelated ones. Used wherever a test needs predictable top-k.
 */
export function bowEmbedVec(text: string): number[] {
  const v = new Array(FAKE_DIM).fill(0);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    v[hashStr(w) % FAKE_DIM] = (v[hashStr(w) % FAKE_DIM] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => (norm > 0 ? x / norm : 0));
}

export const bowEmbedFn = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(texts.map(bowEmbedVec));

export const fakeEmbedFnWithProgress = (
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> => {
  const out = texts.map(fakeEmbedVec);
  onProgress?.(texts.length, texts.length);
  return Promise.resolve(out);
};

/** Assert the embed result is internally consistent with our own math. */
export function similarityOf(texts: [string, string]): number {
  const [a, b] = [fakeEmbedVec(texts[0]!), fakeEmbedVec(texts[1]!)];
  return cosineSimilarity(a, b);
}

export function makePolicyChunk(
  overrides: Partial<PolicyChunkRecord> & { chunk_id: string; text: string },
): PolicyChunkRecord {
  return {
    source_doc: "README.md#fraud-policy",
    source_kind: "policy",
    heading_path: "Fraud Policy",
    token_count: approxTokenCount(overrides.text),
    embedding: fakeEmbedVec(overrides.text),
    ...overrides,
  };
}

export function makeCaseMemoryRecord(
  overrides: Partial<CaseMemoryRecord> & {
    case_id: string;
    visible_from: string;
    summary_text: string;
  },
): CaseMemoryRecord {
  const base: CaseMemoryRecord = {
    source: "closed_case_history",
    customer_id: "C0TEST",
    card_id: "C0TEST-K1",
    connected_card_ids: [],
    pattern: "card_not_present_fraud",
    outcome: "confirmed_fraud",
    exposure_usd: 200,
    opened_at: "2016-07-02 07:17:26",
    closed_at: overrides.visible_from,
    visible_from: overrides.visible_from,
    summary_text: overrides.summary_text,
    analyst_notes: overrides.summary_text,
    fingerprint: {
      pattern: "card_not_present_fraud",
      entity_ids: [
        { type: "Customer", id: "C0TEST" },
        { type: "Card", id: "C0TEST-K1" },
      ],
      amount_band: "100_to_500",
      device_signals: [],
      address_signals: [],
      outcome: "confirmed_fraud",
    },
    embedding: fakeEmbedVec(overrides.summary_text),
    ...overrides,
  };
  return base;
}

export function testFingerprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pattern: "card_not_present_fraud",
    entity_ids: [{ type: "Customer", id: "C0TEST" }],
    amount_band: "100_to_500",
    device_signals: [],
    address_signals: [],
    outcome: "confirmed_fraud",
    summary_text: "cardholder denied an online purchase made from a brand new device",
    ...overrides,
  };
}

export { embedBatch, cosineSimilarity, approxTokenCount };