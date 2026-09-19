import type {
  RetrievePolicy,
  RetrievePolicyData,
  RetrieveSimilarCases,
  SimilarCaseRef,
} from "@hhgoa/contracts";
import { envelope, NO_AS_OF } from "./envelope.js";
import type { VectorStore } from "./store/vectorStore.js";
import type { CaseFingerprint, CaseMemoryRecord, PolicyChunkRecord } from "./types.js";
import { findPattern, PATTERNS } from "./patterns.js";
import { entityOverlapScore, explainOverlap } from "./fingerprint.js";
import { cosineSimilarity } from "./embeddings.js";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface ScoredPolicyChunk {
  id: string;
  record: PolicyChunkRecord;
  score: number;
}

export interface ScoredSimilarCase {
  record: CaseMemoryRecord;
  score: number;
}

/**
 * `retrieve_policy` — hybrid retrieval per PRD §11:
 * (1) vector top-k seeds over `PolicyChunk`s,
 * (2) "graph" expansion from those seed chunks to their `Pattern`(s) and
 *     each pattern's `REQUIRES_EVIDENCE`/permitted-action links
 *     (`patterns.ts` — the local stand-in for WS1's graph; see
 *     `store/vectorStore.ts` header for the adapter boundary).
 * Matches `contracts/src/tools.ts`'s `RetrievePolicy` signature exactly —
 * no `as_of` (policy/pattern text is static reference data, not
 * time-bearing, so PRD §8.1's leak rule doesn't apply to it).
 */
export function makeRetrievePolicy(
  chunkStore: VectorStore<PolicyChunkRecord>,
  embedFn: EmbedFn,
): RetrievePolicy {
  return async (query, pattern_id, k) => {
    const results = await scorePolicyChunks(chunkStore, embedFn, query, pattern_id, k);

    // Graph expansion: union required_evidence/permitted_actions across
    // every pattern touched by the seed chunks (directly via pattern_id,
    // or indirectly via a rule chunk whose rule number the pattern cites).
    const patternIds = expandPatternsFromChunks(
      chunkStore,
      results.map((r) => r.id),
      pattern_id,
    );
    const required_evidence = new Set<string>();
    const permitted_actions = new Set<string>();
    for (const pid of patternIds) {
      const p = findPattern(pid);
      if (!p) continue;
      p.required_evidence.forEach((e) => required_evidence.add(e));
      p.permitted_actions.forEach((a) => permitted_actions.add(a));
    }

    const data: RetrievePolicyData = {
      chunks: results.map((r) => ({
        chunk_id: r.record.chunk_id,
        text: r.record.text,
        source_doc: r.record.source_doc,
        pattern_id: r.record.pattern_id,
      })),
      required_evidence: [...required_evidence],
      permitted_actions: [...permitted_actions],
    };
    return envelope("retrieve_policy", NO_AS_OF, "rag", data, {
      evidence_refs: results.map((r) => r.record.chunk_id),
      truncated: results.length >= k,
    });
  };
}

function ruleTagsIn(headingPath: string): string[] {
  const matches = headingPath.match(/\bR\d+\b/g);
  return matches ?? [];
}

function describesRuleOfPattern(chunk: PolicyChunkRecord, pattern_id: string): boolean {
  const pattern = findPattern(pattern_id);
  if (!pattern) return false;
  const rules = ruleTagsIn(chunk.heading_path);
  return rules.some((r) => pattern.rule_refs.includes(r));
}

/**
 * Vector top-k seeds over `PolicyChunk`s, with a `pattern_id` pre-filter
 * (and an unfiltered backfill when the filter over-narrows). Shared by
 * `makeRetrievePolicy`'s contract wrapper and the context builder (which
 * needs the raw scores to rank with).
 */
export async function scorePolicyChunks(
  chunkStore: VectorStore<PolicyChunkRecord>,
  embedFn: EmbedFn,
  query: string,
  pattern_id: string | undefined,
  k: number,
): Promise<ScoredPolicyChunk[]> {
  const [queryEmbedding] = await embedFn([query]);
  const directFilter = pattern_id
    ? (r: PolicyChunkRecord) => r.pattern_id === pattern_id || describesRuleOfPattern(r, pattern_id)
    : undefined;

  let results = chunkStore.search(queryEmbedding!, k, directFilter);
  // A pattern filter can over-narrow (e.g. a pattern with few chunks);
  // fall back to an unfiltered search rather than returning too few
  // seeds for the context builder to work with.
  if (results.length < Math.min(k, 3) && pattern_id) {
    const backfill = chunkStore.search(queryEmbedding!, k);
    const seen = new Set(results.map((r) => r.id));
    for (const b of backfill) {
      if (results.length >= k) break;
      if (!seen.has(b.id)) {
        results.push(b);
        seen.add(b.id);
      }
    }
  }
  return results.map((r) => ({ id: r.id, record: r.record, score: r.score }));
}

/**
 * PRD §11 §"graph expansion": union the patterns touched by a seed chunk
 * set. Returns the set of pattern ids reached either directly (`chunk.pattern_id`)
 * or via a rule-tag heading (chunk `... > Rules > R5` -> every pattern
 * whose `rule_refs` includes R5). Used to compute `required_evidence` /
 * `permitted_actions` for `retrieve_policy`, and to tell the context
 * builder which pattern(s) the hit chunks describe.
 */
export function expandPatternsFromChunks(
  chunkStore: VectorStore<PolicyChunkRecord>,
  seedIds: string[],
  explicit: string | undefined,
): Set<string> {
  const patternIds = new Set<string>();
  if (explicit) patternIds.add(explicit);
  for (const id of seedIds) {
    const rec = chunkStore.get(id);
    if (!rec) continue;
    if (rec.pattern_id) patternIds.add(rec.pattern_id);
    for (const rule of ruleTagsIn(rec.heading_path)) {
      for (const p of PATTERNS) {
        if (p.rule_refs.includes(rule)) patternIds.add(p.pattern_id);
      }
    }
  }
  return patternIds;
}

/**
 * Best-effort coercion from the contract's `fingerprint: Record<string,
 * unknown>` into our structured `CaseFingerprint` (PRD §11's fingerprint
 * shape). Callers (agent/, WS4) are expected to build the query
 * fingerprint with `buildFingerprint()` from `rag/src/fingerprint.ts` —
 * this coercion just means a plain object with the same field names also
 * works, since the contract type itself is untyped `Record<string,
 * unknown>` and we can't force callers through our constructor.
 */
export function coerceFingerprint(raw: Record<string, unknown>): CaseFingerprint {
  const entity_ids = Array.isArray(raw.entity_ids)
    ? (raw.entity_ids as { type: string; id: string }[])
    : [];
  return {
    pattern: typeof raw.pattern === "string" ? raw.pattern : "none",
    entity_ids,
    amount_band:
      typeof raw.amount_band === "string"
        ? (raw.amount_band as CaseFingerprint["amount_band"])
        : "under_100",
    device_signals: Array.isArray(raw.device_signals) ? (raw.device_signals as string[]) : [],
    address_signals: Array.isArray(raw.address_signals) ? (raw.address_signals as string[]) : [],
    outcome:
      typeof raw.outcome === "string"
        ? (raw.outcome as CaseFingerprint["outcome"])
        : "unresolved",
  };
}

/**
 * `retrieve_similar_cases` — PRD §11: "score = cosine(summary) +
 * entity-overlap ... with `as_of` filtering; returns outcome and why
 * similar." Only records visible by `as_of` (`visible_from <= as_of`,
 * PRD §8.1) are eligible — this is the tool the as_of-leakage test in
 * `tests/ws3/` exercises directly. Only `confirmed_fraud`/`cleared`
 * outcomes are ever returned (matches `SimilarCaseRef.outcome`'s enum in
 * `contracts/src/tools.ts`) — a still-open agent-written case has no
 * outcome yet and isn't offered as precedent until it closes.
 */
/**
 * PRD §11 similar-case scorer: rank case-memory records visible by `as_of`
 * by `cosine(summary) + entity-overlap`, in *chronological-order-agnostic*
 * form — the `as_of` filter is applied here (only records with
 * `visible_from <= as_of` are eligible, and only resolved outcomes are
 * offered as precedent). Shared by `makeRetrieveSimilarCases` (contract
 * wrapper) and the context builder (which needs the raw scores).
 */
export async function scoreSimilarCases(
  caseStore: VectorStore<CaseMemoryRecord>,
  embedFn: EmbedFn,
  fingerprint: Record<string, unknown>,
  as_of: string,
): Promise<ScoredSimilarCase[]> {
  const asOfMs = Date.parse(as_of);
  if (Number.isNaN(asOfMs)) {
    throw new Error(`retrieve_similar_cases: invalid as_of "${as_of}"`);
  }
  const queryFingerprint = coerceFingerprint(fingerprint);
  const summaryText =
    typeof fingerprint.summary_text === "string" ? fingerprint.summary_text : undefined;
  const queryEmbedding = summaryText ? (await embedFn([summaryText]))[0] : undefined;

  const eligible = caseStore
    .all()
    .filter((r) => Date.parse(r.visible_from) <= asOfMs)
    .filter((r) => r.outcome === "confirmed_fraud" || r.outcome === "cleared");

  const scored = eligible.map((r) => {
    const overlap = entityOverlapScore(queryFingerprint, r.fingerprint);
    const cosine = queryEmbedding ? cosineSimilarity(queryEmbedding, r.embedding) : 0;
    // Weighted per PRD §11's "cosine(summary) + entity-overlap" — equal
    // weight by default; entity overlap alone (no query narrative) still
    // produces a usable ranking, which matters since the contract's
    // `fingerprint` param doesn't guarantee a narrative is supplied.
    return { record: r, score: 0.5 * cosine + 0.5 * overlap };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function makeRetrieveSimilarCases(
  caseStore: VectorStore<CaseMemoryRecord>,
  embedFn: EmbedFn,
): RetrieveSimilarCases {
  return async (fingerprint, as_of, k) => {
    // The contract's `toolEnvelope` result shape has an `error` field and
    // the agent's harness is built around failing envelopes, not throws —
    // an unparseable `as_of` (or any other scoring failure) becomes a
    // failing envelope rather than an uncaught rejection.
    try {
      const scored = await scoreSimilarCases(caseStore, embedFn, fingerprint, as_of);

      const top = scored.slice(0, k);
      const cases: SimilarCaseRef[] = top.map((t) => ({
        case_id: t.record.case_id,
        score: t.score,
        outcome: t.record.outcome as "confirmed_fraud" | "cleared",
        overlap_reason: explainOverlap(coerceFingerprint(fingerprint), t.record.fingerprint),
      }));

      return envelope(
        "retrieve_similar_cases",
        as_of,
        "rag",
        { cases },
        { evidence_refs: cases.map((c) => c.case_id), truncated: scored.length > k },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        tool: "retrieve_similar_cases",
        as_of,
        via: "rag",
        data: { cases: [] },
        evidence_refs: [],
        truncated: false,
        latency_ms: 0,
        error: message,
      };
    }
  };
}
