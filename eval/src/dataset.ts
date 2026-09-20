import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readCsv, readCsvLines, splitCsvLine } from "./csv.js";
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
    const derivedCardIds = new Set<string>();
    const txnCustomers = new Set<string>();
    const t0 = Date.now();

    // Stream transactions.csv once: transactions, customers (literal column),
    // and the data needed to reconstruct WS1's derived card ids
    // (`C<card1>-K<rank>` — graph/scripts/prepareLoadFiles.ts). The graph
    // materializes those constructed ids (also visible in graph/build/cards.csv),
    // so the index must accept them too or genuine ring/query results get
    // falsely rejected as "unresolvable".
    interface TupleStats {
      key: string;
      card1: string;
      count: number;
      firstEpoch: number;
    }
    const tupleStats = new Map<string, TupleStats>();
    let headers: string[] | null = null;
    await readCsvLines(txnPath, (rawLine) => {
      const line = rawLine.replace(/^\uFEFF/, "");
      if (line.trim() === "") return;
      const cells = splitCsvLine(line);
      if (headers === null) {
        headers = cells;
        return;
      }
      const col = (name: string): string => cells[headers!.indexOf(name)] ?? "";
      const txnId = col("TransactionID");
      if (txnId !== "") txnIds.add(txnId);
      const cust = col("customer_id");
      if (cust !== "") txnCustomers.add(cust);
      const card1 = col("card1");
      const card2 = col("card2");
      const card3 = col("card3");
      const card5 = col("card5");
      if (card1 === "" && card2 === "" && card3 === "" && card5 === "") return;
      const key = `${card1}|${card2}|${card3}|${card5}`;
      const epochRaw = col("ts");
      const t = new Date((epochRaw || "").replace(" ", "T"));
      const epoch = epochRaw && !Number.isNaN(t.getTime()) ? t.getTime() : 0;
      const prior = tupleStats.get(key);
      if (prior) {
        prior.count += 1;
        if (epoch !== 0 && (prior.firstEpoch === 0 || epoch < prior.firstEpoch)) prior.firstEpoch = epoch;
      } else {
        tupleStats.set(key, { key, card1, count: 1, firstEpoch: epoch });
      }
    });
    // Same ranking as prepareLoadFiles: per card1 by ascending count, then
    // first-transaction epoch, then tuple key.
    const byCard1 = new Map<string, TupleStats[]>();
    for (const m of tupleStats.values()) {
      const list = byCard1.get(m.card1) ?? [];
      list.push(m);
      byCard1.set(m.card1, list);
    }
    for (const [c1, list] of byCard1) {
      list.sort((a, b) => a.count - b.count || a.firstEpoch - b.firstEpoch || (a.key < b.key ? -1 : 1));
      let rank = 0;
      for (const m of list) {
        rank += 1;
        derivedCardIds.add(`C${c1}-K${rank}`);
      }
    }
    // The graph's materialized entity universes (graph/build/*.csv, generated
    // by @hhgoa/graph's prepareLoadFiles from data/*.csv). These are exactly
    // the ids the real graph returns — derived 16-hex device/identity ids,
    // constructed `C<card1>-K<rank>` cards, email domains, addresses. If the
    // graph build dir is absent (fresh clone, no graph yet), the data/-derived
    // card/customer sets above remain the fallback.
    const buildEntityIds = new Set<string>();
    const buildDir = path.join(repoRoot(), "graph", "build");
    if (existsSync(buildDir)) {
      const castTarget = (name: string): Set<string> => {
        if (name === "cards.csv" || name === "stub_cards.csv") return derivedCardIds;
        if (name === "customers.csv") return txnCustomers;
        return buildEntityIds;
      };
      for (const file of ["cards.csv", "stub_cards.csv", "customers.csv", "devices.csv", "identities.csv", "email_domains.csv", "addresses.csv"]) {
        const p = path.join(buildDir, file);
        if (!existsSync(p)) continue;
        const target = castTarget(file);
        const parsed = readCsv(p);
        const idIdx = parsed.headers.indexOf("id");
        if (idIdx === -1) continue;
        for (const row of parsed.rows) {
          const id = row[parsed.headers[idIdx]!] ?? "";
          if (id !== "") target.add(id);
        }
      }
    }

    process.stdout.write(`[eval] indexed ${txnIds.size} transactions, ${derivedCardIds.size} cards, ${buildEntityIds.size} build entity ids in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    const closed = loadClosedCases(base);
    const cardIds = new Set<string>(derivedCardIds);
    const customerIds = new Set<string>(txnCustomers);
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
    for (const s of [txnIds, cardIds, customerIds, closedCaseIds, buildEntityIds]) {
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
