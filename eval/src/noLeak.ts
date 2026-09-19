import type { BenchmarkCase, ClosedCase, DatasetIdIndex } from "./dataset.js";

/**
 * Temporal-correctness harness (PRD §8.1/§15). Every knowledge-layer lookup
 * answerable about a case runs `as of` the case's opened_at; this derives the
 * candidate knowledge that must be excluded (`LeakageOption`) and exposes the
 * cutoff predicate so each tool's `as_of` gate produces identical, auditable
 * boundaries.
 */

/** The day boundary (inclusive) everything must be visible by. */
export function asOfCutoff(asOf: string): string {
  return asOf.slice(0, 10);
}

export function withinAsOf(id: string, tdate: string, asOf: string): boolean {
  return tdate.slice(0, 10) <= asOfCutoff(asOf);
}

/** Which entities may be surfaced for a case, and the ones that must not be. */
export interface LeakageOption {
  case_id: string;
  as_of: string;
  cutoff: string;
  /** Closed cases opened strictly after the cutoff (must be invisible). */
  excluded_closed_ids: string[];
  /** Txns dated after the cutoff (must be invisible). */
  excluded_txn_ids: string[];
  notes: string;
}

/**
 * Derives, per benchmark case, the closed-case/txn knowledge whose own dates
 * postdate the case's `as_of`. Empty when the labeled history is fully within
 * memory (the normal case for the July–Oct history vs Nov–Dec benchmark), which
 * means nothing extra must be masked — always deterministic, never fabricated.
 */
export function buildLeakageOptions(pack: BenchmarkCase[], closed: ClosedCase[], index: DatasetIdIndex): LeakageOption[] {
  const caseById = new Map(pack.map((c) => [c.case_id, c]));
  const byCard = new Map<string, ClosedCase[]>();
  for (const c of closed) {
    for (const card of [c.card_id, ...c.connected_card_ids]) {
      const list = byCard.get(card) ?? [];
      list.push(c);
      byCard.set(card, list);
    }
  }

  return pack.map((bench) => {
    const cutoff = asOfCutoff(bench.opened_at);
    const adjacent = new Set<ClosedCase>();
    for (const card of [bench.card_id]) {
      for (const c of byCard.get(card) ?? []) adjacent.add(c);
    }

    const excluded_closed_ids: string[] = [];
    const excluded_txn_ids: string[] = [];
    for (const c of adjacent) {
      if (c.opened_at.slice(0, 10) > cutoff) {
        excluded_closed_ids.push(c.case_id);
        for (const t of c.txn_ids) excluded_txn_ids.push(t);
      }
    }

    return {
      case_id: bench.case_id,
      as_of: bench.opened_at,
      cutoff,
      excluded_closed_ids: [...new Set(excluded_closed_ids)].sort(),
      excluded_txn_ids: [...new Set(excluded_txn_ids)].sort(),
      notes: `adjacent knowledge derived from closed_cases_history sharing card ${bench.card_id || "(none)"}`,
    };
  });
}

/** CSV line for the audit artifact `data/leakage_options.csv` (consumed by the graph/RAG bridges). */
export function leakageOptionsToCsv(options: LeakageOption[]): string {
  const header = ["case_id", "as_of", "cutoff", "excluded_closed_ids", "excluded_txn_ids", "notes"];
  const esc = (s: string) => (s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = options.map((o) => [o.case_id, o.as_of, o.cutoff, o.excluded_closed_ids.join(";"), o.excluded_txn_ids.join(";"), o.notes].map(esc).join(","));
  return [header.join(","), ...rows].join("\n");
}