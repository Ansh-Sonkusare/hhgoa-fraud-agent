/**
 * Local embeddings via @xenova/transformers running bge-small-en-v1.5 fully
 * in Node — no API key, no Python (PRD §5/OQ7, docs/decisions.md). The
 * pipeline is a lazily-initialized singleton so ingestion and retrieval
 * share one loaded model instead of reloading per call.
 */

// transformers.js has no first-class TS types for the pipeline factory's
// return shape; `any` is narrowed immediately at the call sites below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = (
  text: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

const MODEL_ID = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = 384;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      // Dynamic import: @xenova/transformers is ESM-only and fairly heavy
      // to load (ONNX runtime), so don't pay that cost for callers that
      // never embed anything (e.g. pure chunking unit tests).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { pipeline } = (await import("@xenova/transformers")) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await pipeline("feature-extraction", MODEL_ID)) as any;
    })();
  }
  return pipelinePromise;
}

/** Embed one string. Returns a unit-normalized 384-dim vector. */
export async function embedText(text: string): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as ArrayLike<number>);
}

/**
 * Embed many strings. Sequential by design — transformers.js's ONNX
 * runtime session is not safely reentrant for concurrent calls in this
 * setup, and ingestion (the only bulk caller) is a one-off offline step,
 * not a request-latency path.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embedText(texts[i]!));
    onProgress?.(i + 1, texts.length);
  }
  return out;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
