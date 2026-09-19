import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { cosineSimilarity } from "../embeddings.js";

/**
 * Adapter boundary (PRD §11 fallback / task brief): WS1's `graph/schema.gsql`
 * doesn't exist yet in this worktree (checked — `graph/` is still just a
 * package.json stub), so real TigerGraph native-vector storage isn't
 * available to build against. Everything in `rag/` is written against this
 * interface, not against `LocalJsonVectorStore` directly, so swapping in a
 * real `TigerGraphVectorStore` later is a one-line change at the call site
 * (see `rag/src/index.ts`), not a rewrite. See `docs/REQUESTS.md` for the
 * exact vertex/edge shape requested from WS1.
 */
export interface VectorStore<T> {
  upsert(id: string, embedding: number[], record: T): void;
  get(id: string): T | undefined;
  all(): T[];
  /** Cosine top-k over the store, with an optional pre-filter. */
  search(
    queryEmbedding: number[],
    k: number,
    filter?: (record: T) => boolean,
  ): { id: string; record: T; score: number }[];
  save(): void;
  load(): void;
  clear(): void;
}

interface Entry<T> {
  id: string;
  embedding: number[];
  record: T;
}

/**
 * File-backed vector store (JSON on disk under `rag/.data/`). This is the
 * "local index" fallback PRD §11 explicitly allows: "if native vectors are
 * unavailable, use a local index keyed by vertex id and flag it in the
 * blog." Good enough for correctness and for the 20-case benchmark's
 * corpus sizes (thousands of chunks/cases, not millions) — linear cosine
 * scan is fine at this scale and keeps the whole pipeline runnable with no
 * external service.
 */
export class LocalJsonVectorStore<T> implements VectorStore<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(private readonly filePath: string) {}

  upsert(id: string, embedding: number[], record: T): void {
    this.entries.set(id, { id, embedding, record });
  }

  get(id: string): T | undefined {
    return this.entries.get(id)?.record;
  }

  all(): T[] {
    return Array.from(this.entries.values()).map((e) => e.record);
  }

  search(
    queryEmbedding: number[],
    k: number,
    filter?: (record: T) => boolean,
  ): { id: string; record: T; score: number }[] {
    const scored: { id: string; record: T; score: number }[] = [];
    for (const e of this.entries.values()) {
      if (filter && !filter(e.record)) continue;
      scored.push({
        id: e.id,
        record: e.record,
        score: cosineSimilarity(queryEmbedding, e.embedding),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  save(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = Array.from(this.entries.values());
    writeFileSync(this.filePath, JSON.stringify(payload), "utf-8");
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      this.entries = new Map();
      return;
    }
    const raw = readFileSync(this.filePath, "utf-8");
    const payload = JSON.parse(raw) as Entry<T>[];
    this.entries = new Map(payload.map((e) => [e.id, e]));
  }

  clear(): void {
    this.entries = new Map();
  }
}

/**
 * Stub for the real adapter. Intentionally throws rather than silently
 * degrading — once WS1's schema/vector attributes land, this gets a real
 * implementation (REST-API upsert + `vectorSearch()` installed query) and
 * `rag/src/index.ts` switches to it behind the same `VectorStore<T>`
 * interface. Until then nothing should construct this.
 */
export class TigerGraphVectorStore<T> implements VectorStore<T> {
  constructor() {
    throw new Error(
      "TigerGraphVectorStore is not implemented yet — WS1's graph/schema.gsql " +
        "did not exist in this worktree as of WS3 implementation time. " +
        "See docs/REQUESTS.md ('WS3 asks WS1') for the vertex/edge shape " +
        "needed (PolicyChunk/Case vector attributes + DESCRIBES/SIMILAR_TO " +
        "edges). Use LocalJsonVectorStore until that lands.",
    );
  }
  upsert(): void {
    throw new Error("not implemented");
  }
  get(): undefined {
    throw new Error("not implemented");
  }
  all(): never[] {
    throw new Error("not implemented");
  }
  search(): never[] {
    throw new Error("not implemented");
  }
  save(): void {
    throw new Error("not implemented");
  }
  load(): void {
    throw new Error("not implemented");
  }
  clear(): void {
    throw new Error("not implemented");
  }
}
