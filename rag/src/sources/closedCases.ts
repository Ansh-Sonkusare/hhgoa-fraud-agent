import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseCsvObjects } from "./csv.js";

/** One row of `data/closed_cases_history.csv` (docs/DATA_MAP.md's column list). */
export interface ClosedCaseRow {
  case_id: string;
  customer_id: string;
  card_id: string;
  opened_at: string;
  closed_at: string;
  outcome: "confirmed_fraud" | "cleared";
  pattern: string;
  first_fraud_txn_id: string;
  txn_ids: string[];
  n_txns: number;
  exposure_usd: number;
  connected_card_ids: string[];
  actions_taken: string[];
  report_filed: boolean;
  analyst_notes: string;
}

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "..");
}

function dataPath(file: string): string {
  return path.join(repoRoot(), "data", file);
}

function splitPipe(s: string): string[] {
  return s
    .split("|")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function loadClosedCases(): ClosedCaseRow[] {
  const content = readFileSync(dataPath("closed_cases_history.csv"), "utf-8");
  const rows = parseCsvObjects(content);
  return rows.map((r) => ({
    case_id: r.case_id ?? "",
    customer_id: r.customer_id ?? "",
    card_id: r.card_id ?? "",
    opened_at: r.opened_at ?? "",
    closed_at: r.closed_at ?? "",
    outcome: (r.outcome as "confirmed_fraud" | "cleared") ?? "cleared",
    pattern: r.pattern ?? "none",
    first_fraud_txn_id: r.first_fraud_txn_id ?? "",
    txn_ids: splitPipe(r.txn_ids ?? ""),
    n_txns: Number(r.n_txns ?? 0),
    exposure_usd: Number(r.exposure_usd ?? 0),
    connected_card_ids: splitPipe(r.connected_card_ids ?? ""),
    actions_taken: splitPipe(r.actions_taken ?? ""),
    report_filed: (r.report_filed ?? "No").trim().toLowerCase() === "yes",
    analyst_notes: r.analyst_notes ?? "",
  }));
}

/** One row of `data/case_pack.csv` — the 20 benchmark triggers. */
export interface CasePackRow {
  case_id: string;
  opened_at: string;
  trigger_type: "risk_score" | "customer_report" | "analyst_request";
  trigger_text: string;
  flagged_txn_id: string;
  card_id: string;
  customer_id: string;
  risk_score: number | null;
}

export function loadCasePack(): CasePackRow[] {
  const content = readFileSync(dataPath("case_pack.csv"), "utf-8");
  const rows = parseCsvObjects(content);
  return rows.map((r) => ({
    case_id: r.case_id ?? "",
    opened_at: r.opened_at ?? "",
    trigger_type: r.trigger_type as CasePackRow["trigger_type"],
    trigger_text: r.trigger_text ?? "",
    flagged_txn_id: r.flagged_txn_id ?? "",
    card_id: r.card_id ?? "",
    customer_id: r.customer_id ?? "",
    risk_score: r.risk_score && r.risk_score.length > 0 ? Number(r.risk_score) : null,
  }));
}
