import type { CaseMemoryRecord } from "./types.js";
import { loadClosedCases, type ClosedCaseRow } from "./sources/closedCases.js";
import { getTransactionSignals, type TransactionSignal } from "./sources/transactionSignals.js";
import { buildFingerprint } from "./fingerprint.js";

type EmbedFn = (
  texts: string[],
  onProgress?: (done: number, total: number) => void,
) => Promise<number[][]>;

/** The `analyst_notes` field is already a well-formed narrative (it's the
 * bank's own case writeup) — use it directly as the embedded summary text
 * rather than synthesizing a new one, per PRD §11's "summary embedding". */
export function buildCaseSummaryText(row: ClosedCaseRow): string {
  return row.analyst_notes;
}

export interface IngestCasesOptions {
  /** Join transactions.csv/identity.csv for device/address fingerprint
   * signals (PRD §11). Default true; set false for fast/offline tests. */
  withTransactionSignals?: boolean;
  onProgress?: (done: number, total: number) => void;
  /** Cap the number of cases ingested (smoke runs / fast tests). */
  limit?: number;
}

/**
 * Loads `data/closed_cases_history.csv` (5,565 rows, July-Oct 2016), the
 * agent's starting case memory (README, PRD §11), fingerprints and embeds
 * each one. `visible_from` is set to `closed_at`: the bank's own outcome
 * for a case isn't knowable/citable until the case actually closed, which
 * is what makes this dataset usable for `as_of`-correct retrieval instead
 * of leaking the answer key backward.
 */
export async function ingestClosedCases(
  embedFn: EmbedFn,
  opts: IngestCasesOptions = {},
): Promise<CaseMemoryRecord[]> {
  const rows = opts.limit ? loadClosedCases().slice(0, opts.limit) : loadClosedCases();

  let signals = new Map<string, TransactionSignal>();
  if (opts.withTransactionSignals !== false) {
    const ids = new Set(rows.map((r) => r.first_fraud_txn_id).filter((id) => id.length > 0));
    signals = await getTransactionSignals(ids);
  }

  const summaries = rows.map(buildCaseSummaryText);
  const embeddings = await embedFn(summaries, opts.onProgress);

  return rows.map((row, i) => {
    const signal = signals.get(row.first_fraud_txn_id);
    const fingerprint = buildFingerprint({
      pattern: row.pattern,
      customer_id: row.customer_id,
      card_id: row.card_id,
      connected_card_ids: row.connected_card_ids,
      exposure_usd: row.exposure_usd,
      outcome: row.outcome,
      signal,
    });
    return {
      case_id: row.case_id,
      source: "closed_case_history",
      customer_id: row.customer_id,
      card_id: row.card_id,
      connected_card_ids: row.connected_card_ids,
      pattern: row.pattern,
      outcome: row.outcome,
      exposure_usd: row.exposure_usd,
      opened_at: row.opened_at,
      closed_at: row.closed_at,
      visible_from: row.closed_at,
      summary_text: summaries[i]!,
      analyst_notes: row.analyst_notes,
      fingerprint,
      embedding: embeddings[i]!,
    };
  });
}
