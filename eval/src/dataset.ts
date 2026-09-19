import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readCsv, readCsvColumnAsync } from "./csv.js";
import { repoRoot } from "./env.js";

/** Dataset readers. All datasets are the gitignored `data/*.csv` (never committed). */

export interface DatasetDir {
  dir: string;
  require(file: string, label: string): string;
}

export function datasetDir(base: string = path.join(repoRoot(), "data")): DatasetDir {
  return {
    dir: base,
    require(file, label) {
      const p = path.join(base, file);
      if (!existsSync(p)) {
        throw new Error(`${label}: missing dataset file ${p} (raw data lives in gitignored data/ — see docs/DATASET_README.md)`);
      }
      return p;
    },
  };
}

/** One row of `case_pack.csv` (the 20 benchmark cases; README "The 20 Cases"). */
export interface BenchmarkCase {
  case_id: string;
  opened_at: string;
  trigger_type: "risk_score" | "customer_report" | "analyst_request";
  flagged_txn_id: string;
  card_id: string;
  customer_id: string;
  risk_score: number | null;
  trigger_text: string;
}

/** Parses the 20 case-pack rows, checks the count, sorts chronologically by opened_at. */
export function loadCasePack(base?: string): BenchmarkCase[] {
  const ds = datasetDir(base);
  const parsed = readCsv(ds.require("case_pack.csv", "case pack"));
  const cases: BenchmarkCase[] = parsed.rows.map((r) => {
    const tt = r.trigger_type;
    if (tt !== "risk_score" && tt !== "customer_report" && tt !== "analyst_request") {
      throw new Error(`case pack: unknown trigger_type "${tt}"`);
    }
    const riskRaw = r.risk_score ?? "";
    const risk = riskRaw === "" || riskRaw === "—" ? null : Number(riskRaw);
    if (risk !== null && Number.isNaN(risk)) throw new Error(`case pack: bad risk_score "${riskRaw}" for ${r.case_id}`);
    return {
      case_id: r.case_id ?? "",
      opened_at: r.opened_at ?? "",
      trigger_type: tt,
      flagged_txn_id: r.flagged_txn_id ?? "",
      card_id: r.card_id ?? "",
      customer_id: r.customer_id ?? "",
      risk_score: risk,
      trigger_text: r.trigger_text ?? "",
    };
  });
  if (cases.length !== 20) {
    throw new Error(`case pack: expected 20 benchmark cases, found ${cases.length}`);
  }
  if (new Set(cases.map((c) => c.case_id)).size !== 20) {
    throw new Error("case pack: duplicate case_ids");
  }
  return [...cases].sort((a, b) => (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : 0));
}

export const CLOSED_OUTCOME = ["confirmed_fraud", "cleared"] as const;
export type ClosedOutcome = (typeof CLOSED_OUTCOME)[number];

/** One row of `closed_cases_history.csv` (the labeled July–Oct training history). */
export interface ClosedCase {
  case_id: string;
  customer_id: string;
  card_id: string;
  opened_at: string;
  closed_at: string;
  outcome: ClosedOutcome;
  pattern: string;
  first_fraud_txn_id: string;
  txn_ids: string[];
  n_txns: number;
  exposure_usd: number;
  connected_card_ids: string[];
  report_filed: boolean;
  analyst_notes: string;
}

/** Parses the full closed-case history (5,565 rows). */
export function loadClosedCases(base?: string): ClosedCase[] {
  const ds = datasetDir(base);
  const parsed = readCsv(ds.require("closed_cases_history.csv", "closed cases"));
  return parsed.rows.map((r) => {
    const outcome = r.outcome;
    if (outcome !== "confirmed_fraud" && outcome !== "cleared") {
      throw new Error(`closed cases: bad outcome "${outcome}" for ${r.case_id}`);
    }
    return {
      case_id: r.case_id ?? "",
      customer_id: r.customer_id ?? "",
      card_id: r.card_id ?? "",
      opened_at: r.opened_at ?? "",
      closed_at: r.closed_at ?? "",
      outcome,
      pattern: r.pattern ?? "",
      first_fraud_txn_id: r.first_fraud_txn_id ?? "",
      txn_ids: (r.txn_ids ?? "").split("|").filter((s) => s !== ""),
      n_txns: Number(r.n_txns ?? 0) || 0,
      exposure_usd: Number(r.exposure_usd ?? 0) || 0,
      connected_card_ids: (r.connected_card_ids ?? "").split("|").filter((s) => s !== ""),
      report_filed: Boolean(r.report_filed ?? false),
      analyst_notes: r.analyst_notes ?? "",
    };
  });
}

/** The id namespaces the validator resolves; where each namespace comes from. */
export interface DatasetIdIndex {
  txnIds: Set<string>;
  cardIds: Set<string>;
  customerIds: Set<string>;
  closedCaseIds: Set<string>;
  anyId: Set<string>;
}

let cachedIndex: { key: string; promise: Promise<DatasetIdIndex> } | null = null;

export function loadIdIndex(base?: string): Promise<DatasetIdIndex> {
  const ds = datasetDir(base);
  const txnPath = ds.require("transactions.csv", "transactions");
  const closedPath = ds.require("closed_cases_history.csv", "closed cases");
  const packPath = ds.require("case_pack.csv", "case pack");
  const key = `${txnPath}\n${closedPath}\n${packPath}`;
  if (cachedIndex && cachedIndex.key === key) return cachedIndex.promise;

  const promise = (async (): Promise<DatasetIdIndex> => {
    const txnIds = new Set<string>();
    const t0 = Date.now();
    const fresh = await readCsvColumnAsync(txnPath, "TransactionID");
    for (const id of fresh) txnIds.add(id);
    process.stdout.write(`[eval] indexed ${txnIds.size} transaction ids in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    const closed = loadClosedCases(base);
    const cardIds = new Set<string>();
    const customerIds = new Set<string>();
    for (const c of closed) {
      cardIds.add(c.card_id);
      for (const id of c.connected_card_ids) cardIds.add(id);
      customerIds.add(c.customer_id);
    }
    const closedCaseIds = new Set<string>();
    for (const c of closed) closedCaseIds.add(c.case_id);

    const pack = loadCasePack(base);
    for (const c of pack) {
      cardIds.add(c.card_id);
      customerIds.add(c.customer_id);
    }

    const anyId = new Set<string>();
    for (const s of [txnIds, cardIds, customerIds, closedCaseIds]) {
      for (const id of s) anyId.add(id);
    }

    return { txnIds, cardIds, customerIds, closedCaseIds, anyId };
  })();

  cachedIndex = { key, promise };
  return promise;
}

/** Human-readable namespace summary (used by diagnostics). */
export function indexStats(index: DatasetIdIndex): Record<string, number> {
  return {
    transactions: index.txnIds.size,
    cards: index.cardIds.size,
    customers: index.customerIds.size,
    closed_cases: index.closedCaseIds.size,
    any_ids: index.anyId.size,
  };
}
