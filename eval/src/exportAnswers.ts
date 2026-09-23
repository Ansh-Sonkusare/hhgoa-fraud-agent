import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AnswerFileSchema, type AnswerFile } from "@hhgoa/contracts";
import type { RunResult } from "@hhgoa/agent";
import type { CaseRun } from "./runner.js";

/**
 * WS7 exporter. The machine already assembles an `AnswerFile` it validates
 * against `contracts/answerFile.ts`; `exportAnswerFile` applies the README's
 * cross-field rules that are easy to drift in code (PRD §13 "Notes worth
 * repeating") and stamps the measured latency, then re-validates. No new
 * top-level fields are invented — the shape is exactly the README's.
 */
export function exportAnswerFile(result: RunResult | CaseRun, latencyOverrideMs?: number): AnswerFile {
  const answer = (result as { answer: AnswerFile }).answer;
  const latencyMs = latencyOverrideMs ?? ("latencyMs" in result ? result.latencyMs : 0);

  const out: AnswerFile = { ...answer };

  if (out.case.verdict === "legitimate") {
    out.case.affected_txn_ids = [];
    out.case.first_suspicious_txn_id = "";
  }
  if (out.case.verdict === "legitimate") {
    out.case.exposure_usd = 0;
    out.sar.file = false;
    out.sar.reason = "";
    out.sar.narrative = "";
    out.sar.subjects = [];
    out.sar.total_amount_usd = 0;
    out.sar.activity_dates = [];
    // A legitimate case never files a SAR, so it must not carry FILE_REPORT.
    out.next_best_actions.initial = out.next_best_actions.initial.filter((a) => a.action !== "FILE_REPORT");
    out.next_best_actions.final = out.next_best_actions.final.filter((a) => a.action !== "FILE_REPORT");
  }

  const filesReport0 = out.next_best_actions.final.some((a) => a.action === "FILE_REPORT");
  if (out.sar.file !== filesReport0) {
    out.sar.file = filesReport0;
    if (!filesReport0) {
      out.sar.reason = "";
      out.sar.narrative = "";
      out.sar.subjects = [];
      out.sar.total_amount_usd = 0;
      out.sar.activity_dates = [];
    }
  }

  if (out.case.pattern === "undocumented" && (out.case.pattern_description === "" || !out.case.pattern_description)) {
    out.case.pattern_description = "An atypical activity pattern the documented typologies do not cover.";
  }
  if (out.case.pattern !== "undocumented") {
    out.case.pattern_description = "";
  }

  if (out.evidence_requests.length === 0) {
    out.next_best_actions.final = out.next_best_actions.initial;
    out.next_best_actions.what_changed = "nothing";
  }

  // sar.file must agree with FILE_REPORT in the *final* action set; the
  // evidence-reset above may have removed the filing, so re-sync here.
  const filesReport = out.next_best_actions.final.some((a) => a.action === "FILE_REPORT");
  if (out.sar.file !== filesReport) {
    out.sar.file = filesReport;
    if (!filesReport) {
      out.sar.reason = "";
      out.sar.narrative = "";
      out.sar.subjects = [];
      out.sar.total_amount_usd = 0;
      out.sar.activity_dates = [];
    }
  }
  if (out.sar.file && (out.sar.narrative === "" || out.sar.narrative === undefined)) {
    // A filed report without a narrative would fail the README's SAR rule;
    // keep the machine's reason but never ship an empty narrative.
    out.sar.narrative = out.sar.reason || "No narrative was generated for this filing.";
  }

  out.latency_s = Number((latencyMs / 1000).toFixed(2));

  return AnswerFileSchema.parse(out);
}

/** Writes the 20 answer files to `cases/` (one JSON per case, README-named). */
export function writeAnswersDir(
  runs: CaseRun[],
  casesDir: string,
  errorWriter: (id: string, error: string, casesDir: string) => void = writeErrorFile,
): void {
  mkdirSync(casesDir, { recursive: true });
  for (const run of runs) {
    if (run.answer) {
      const answer = exportAnswerFile(run);
      writeFileSync(path.join(casesDir, `${run.case_id}.json`), JSON.stringify(answer, null, 2) + "\n", "utf8");
    } else {
      errorWriter(run.case_id, run.error ?? "no answer produced", casesDir);
    }
  }
}

export function writeErrorFile(caseId: string, error: string, casesDir = "cases"): void {
  // Default error marker: a clearly-invalid file so `make validate-answers`
  // flags it loudly instead of silently dropping the case from the count.
  // Must land in the same directory as the successful answers — writing it
  // to a cwd-relative "cases" instead left the real answer file untouched,
  // so a failed case silently kept the previous run's result and validated
  // clean.
  const out = path.join(casesDir, `${caseId}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ case_id: caseId, error, _error: true }, null, 2) + "\n",
    "utf8",
  );
}

/** True if the writer emitted an error marker (used by the validator). */
export function isErrorMarker(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const a = answer as Record<string, unknown>;
  return a._error === true || a.error === true || typeof a.run_error_marker === "string";
}