import type { CaseRecord } from "@hhgoa/contracts";
import type { VectorStore } from "./store/vectorStore.js";
import type { CaseMemoryRecord } from "./types.js";
import { buildFingerprint } from "./fingerprint.js";

type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface WriteCaseMemoryInput {
  case_id: string;
  case_record: CaseRecord; // contracts/src/answerFile.ts's `case` object
  customer_id: string;
  card_id: string;
  /** MEMORY_UPDATE timestamp (PRD §9.2) — becomes this record's
   * `visible_from`, i.e. the earliest `as_of` a later investigation can
   * retrieve it at (PRD §8.1). */
  as_of: string;
}

function outcomeFromVerdict(
  verdict: CaseRecord["verdict"],
  status: CaseRecord["status"],
): CaseMemoryRecord["outcome"] {
  if (verdict === "fraud") return "confirmed_fraud";
  if (verdict === "legitimate") return "cleared";
  // "uncertain" verdict: only counts as a resolved outcome once actually
  // closed; an escalated/open uncertain case isn't citable as precedent
  // yet (retrieve.ts filters "unresolved" out of retrieve_similar_cases).
  if (status === "closed_fraud") return "confirmed_fraud";
  if (status === "closed_legitimate") return "cleared";
  return "unresolved";
}

/**
 * Memory write path (PRD §11 "Write path (`memory.ts`)"): on MEMORY_UPDATE,
 * turn the agent's finished `CaseRecord` into a `CaseMemoryRecord` —
 * fingerprinted and embedded exactly like a historical closed case — and
 * upsert it into the shared case-memory vector store, so
 * `retrieve_similar_cases` can find it from a *later* investigation's
 * `as_of` (PRD §11: "Benchmark cases run in chronological order so later
 * cases can retrieve earlier ones").
 *
 * This is the local-adapter side of "write it into the graph" (README,
 * Answer Format: "your agent should also write the case into the graph").
 * Real graph write-back (`Case`/`Finding`/`Action`/`Decision`/
 * `EvidenceItem` vertices, PRD §7) is WS1's schema + WS4's case tools
 * (`case_open`/`case_add_evidence`/... in `contracts/src/tools.ts`) — this
 * function only owns the *retrievable-memory* half of that (PRD §11's
 * bullet), which is WS3's. Once WS1's schema exists, this function's body
 * swaps `LocalJsonVectorStore` for `TigerGraphVectorStore` (see
 * `store/vectorStore.ts`) without changing its signature.
 */
export async function writeCaseToMemory(
  store: VectorStore<CaseMemoryRecord>,
  embedFn: EmbedFn,
  input: WriteCaseMemoryInput,
): Promise<CaseMemoryRecord> {
  const outcome = outcomeFromVerdict(input.case_record.verdict, input.case_record.status);
  const summary = input.case_record.summary;
  const [embedding] = await embedFn([summary]);
  const fingerprint = buildFingerprint({
    pattern: input.case_record.pattern,
    customer_id: input.customer_id,
    card_id: input.card_id,
    connected_card_ids: input.case_record.connected_card_ids,
    exposure_usd: input.case_record.exposure_usd,
    outcome,
  });

  const record: CaseMemoryRecord = {
    case_id: input.case_id,
    source: "agent_written",
    customer_id: input.customer_id,
    card_id: input.card_id,
    connected_card_ids: input.case_record.connected_card_ids,
    pattern: input.case_record.pattern,
    outcome,
    exposure_usd: input.case_record.exposure_usd,
    opened_at: input.as_of,
    closed_at: input.case_record.status.startsWith("closed") ? input.as_of : null,
    visible_from: input.as_of,
    summary_text: summary,
    analyst_notes: summary,
    fingerprint,
    embedding: embedding!,
  };

  store.upsert(record.case_id, record.embedding, record);
  return record;
}

export interface EntityCaseStats {
  prior_case_count: number;
  confirmed_fraud_count: number;
  cleared_count: number;
  case_ids: string[];
}

/**
 * Entity-level recurring-case stats (PRD §11: "Recurring entities:
 * `memory.ts` exposes entity-level stats (prior case count,
 * confirmed-fraud count)"). PRD's prose names `find_prior_cases` as the
 * consumer of this data, but that's a *graph* tool in `contracts/src/tools.ts`
 * (WS1/WS2's MCP-backed catalog, not WS3's RAG group) — this function is
 * the data WS3 owns and can feed a real `find_prior_cases` implementation
 * or the agent directly, respecting the same `as_of` visibility rule as
 * `retrieve_similar_cases`.
 */
export function getEntityCaseStats(
  store: VectorStore<CaseMemoryRecord>,
  entity: { type: "Customer" | "Card"; id: string },
  as_of: string,
): EntityCaseStats {
  const asOfMs = Date.parse(as_of);
  const matching = store
    .all()
    .filter((r) => Date.parse(r.visible_from) <= asOfMs)
    .filter((r) => {
      if (entity.type === "Customer") return r.customer_id === entity.id;
      return r.card_id === entity.id || r.connected_card_ids.includes(entity.id);
    });
  return {
    prior_case_count: matching.length,
    confirmed_fraud_count: matching.filter((r) => r.outcome === "confirmed_fraud").length,
    cleared_count: matching.filter((r) => r.outcome === "cleared").length,
    case_ids: matching.map((r) => r.case_id),
  };
}
