import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AnswerFileSchema, type AnswerFile } from "@hhgoa/contracts";
import type { DatasetIdIndex } from "./dataset.js";
import { isErrorMarker } from "./exportAnswers.js";

export interface ValidateOptions {
  /** Require exactly the 20 case-pack files. */
  expectCaseIds?: ReadonlySet<string>;
  /** When set (real graph available), verify `written_to_graph` vertices. */
  withGraph?: boolean;
}

export interface FileReport {
  file: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  answer: AnswerFile | null;
}

export interface ValidateSummary {
  ok: boolean;
  files: FileReport[];
  errors: string[];
  caseCount: number;
  expectedCount: number;
}

/** True if the string looks like a free-form device/profile label rather than a dataset id. */
function isDeviceLike(s: string): boolean {
  return /\s+|&|\|/.test(s) && s.length > 12;
}

function resolveEntityId(id: string, index: DatasetIdIndex): boolean {
  return index.anyId.has(id) || isDeviceLike(id);
}

/** Validates the README rules one file can't violate (PRD §13 notes). */
export function validateAnswerFile(answer: AnswerFile, index: DatasetIdIndex, file: string, warnings: string[]): string[] {
  const errors: string[] = [];
  const { case: c } = answer;

  if (c.verdict === "legitimate") {
    if (c.affected_txn_ids.length !== 0) errors.push("legitimate verdict but affected_txn_ids is non-empty");
    if (c.exposure_usd !== 0) errors.push("legitimate verdict but exposure_usd is not 0");
    if (answer.sar.file) errors.push("legitimate verdict but sar.file is true");
  }

  const filesReport = answer.next_best_actions.final.some((a) => a.action === "FILE_REPORT");
  if (answer.sar.file !== filesReport) {
    errors.push(`sar.file (${answer.sar.file}) does not agree with FILE_REPORT in next_best_actions.final (${filesReport})`);
  }
  if (!answer.sar.file && (answer.sar.narrative !== "" || answer.sar.subjects.length !== 0 || answer.sar.total_amount_usd !== 0 || answer.sar.activity_dates.length !== 0)) {
    errors.push("sar.file false but SAR still carries narrative/subjects/amount/dates");
  }
  if (answer.sar.file && answer.sar.narrative.length < 60) {
    errors.push(`sar.file true but narrative is only ${answer.sar.narrative.length} chars (a regulator file must stand alone)`);
  }

  if (c.pattern === "undocumented" && (c.pattern_description === "" || c.pattern_description.length < 2)) {
    errors.push("pattern undocumented but pattern_description is empty");
  }
  if (c.pattern !== "undocumented" && c.pattern_description !== "") {
    errors.push(`pattern ${c.pattern} but pattern_description is non-empty`);
  }

  if (answer.evidence_requests.length === 0) {
    if (JSON.stringify(answer.next_best_actions.final) !== JSON.stringify(answer.next_best_actions.initial)) {
      errors.push("no evidence requests but next_best_actions.final differs from initial");
    }
    if (answer.next_best_actions.what_changed !== "nothing") {
      errors.push("no evidence requests but what_changed is not \"nothing\"");
    }
  }

  // ID resolution (PRD §13: every referenced ID must exist in the dataset).
  for (const id of c.affected_txn_ids) {
    if (!index.txnIds.has(id)) errors.push(`affected_txn_ids references unknown transaction "${id}"`);
  }
  if (c.first_suspicious_txn_id !== "" && !index.txnIds.has(c.first_suspicious_txn_id)) {
    errors.push(`first_suspicious_txn_id references unknown transaction "${c.first_suspicious_txn_id}"`);
  }
  for (const id of c.connected_card_ids) {
    if (!index.cardIds.has(id)) errors.push(`connected_card_ids references unknown card "${id}"`);
  }
  for (const id of c.similar_prior_cases) {
    if (!index.closedCaseIds.has(id)) errors.push(`similar_prior_cases references unknown closed case "${id}"`);
  }
  for (let i = 0; i < c.evidence.length; i++) {
    for (const id of c.evidence[i]!.entity_ids) {
      if (!resolveEntityId(id, index)) errors.push(`evidence[${i}].entity_ids references unresolvable id "${id}"`);
    }
  }
  for (const s of answer.sar.subjects) {
    if (!resolveEntityId(s, index)) errors.push(`sar.subjects references unresolvable id "${s}"`);
  }

  if (c.written_to_graph && c.graph_case_id === "") {
    errors.push("written_to_graph true but graph_case_id is empty");
  }
  if (c.written_to_graph && c.graph_case_id !== "" && !index.anyId.has(c.graph_case_id) && !/^(GRAPH-|CASE-|case-|c-|graph_)/.test(c.graph_case_id)) {
    // Graph case ids are run-assigned, not dataset ids — the in-memory ledger
    // mints synthetic `GRAPH-<case_id>` ids (agent/src/caseLedger.ts) and the
    // real graph has no case vertices on this build — only warn when the id
    // matches neither a dataset id nor a known synthetic prefix.
    warnings.push(`graph_case_id "${c.graph_case_id}" is run-assigned (not a dataset id) — can't verify without a live graph`);
  }

  // PRD §13 / README: investigation_record is the full AgentEvent timeline,
  // required non-empty and in strictly increasing seq order.
  if (answer.investigation_record.length === 0) {
    errors.push("investigation_record is empty (must record the investigation timeline)");
  }
  for (let i = 1; i < answer.investigation_record.length; i++) {
    const prev = answer.investigation_record[i - 1]!;
    const cur = answer.investigation_record[i]!;
    if (cur.seq <= prev.seq) {
      errors.push(`investigation_record seq is not strictly increasing at index ${i} (${prev.seq} -> ${cur.seq})`);
    }
  }

  return errors;
}

/** Validates one answer file against schema + dataset + cross-field rules. */
export function validateCaseFile(
  absPath: string,
  index: DatasetIdIndex,
  opts: ValidateOptions = {},
): FileReport {
  const file = path.basename(absPath);
  const warnings: string[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(absPath, "utf8"));
    if (isErrorMarker(raw)) {
      return { file, ok: false, errors: ["run error marker — the case failed to produce an answer"], warnings, answer: null };
    }
    const answer = AnswerFileSchema.parse(raw);
    const errors = validateAnswerFile(answer, index, file, warnings);
    if (opts.withGraph && answer.case.written_to_graph) {
      warnings.push("written_to_graph verification against TigerGraph is delegated to WS3's graph-side work; not re-checked here");
    }
    return { file, ok: errors.length === 0, errors, warnings, answer };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { file, ok: false, errors: [`schema/parse failure: ${msg}`], warnings, answer: null };
  }
}

/** Validates the whole `cases/` directory. */
export function validateAnswersDir(casesDir: string, index: DatasetIdIndex, opts: ValidateOptions = {}): ValidateSummary {
  const expected = opts.expectCaseIds;
  let files: string[] = [];
  try {
    files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return {
      ok: false,
      files: [],
      errors: [`cases directory ${casesDir} not found — run the benchmark first`],
      caseCount: 0,
      expectedCount: expected?.size ?? 20,
    };
  }

  const reports = files.map((f) => validateCaseFile(path.join(casesDir, f), index, opts));
  const caseCount = reports.length;
  const expectedCount = expected?.size ?? 20;

  const errors: string[] = [];
  if (expected && caseCount !== expectedCount) {
    errors.push(`expected ${expectedCount} answer files in ${casesDir}, found ${caseCount}`);
  }
  const missing = expected ? [...expected].filter((id) => !reports.some((r) => r.file.replace(/\.json$/, "") === id)) : [];
  if (missing.length > 0) errors.push(`missing answer files: ${missing.join(", ")}`);

  const failed = reports.filter((r) => !r.ok);
  for (const r of failed) {
    for (const e of r.errors) errors.push(`${r.file}: ${e}`);
  }

  return { ok: errors.length === 0, files: reports, errors, caseCount, expectedCount };
}

/** Bundled CLI behavior: validate `cases/` and exit non-zero on failure. */
export function runValidation(casesDir: string, index: DatasetIdIndex, opts: ValidateOptions): { summary: ValidateSummary; printed: string } {
  const summary = validateAnswersDir(casesDir, index, opts);
  const lines: string[] = [];
  lines.push(`validating ${summary.caseCount}/${summary.expectedCount} answer files in ${casesDir}`);
  for (const r of summary.files) {
    const tag = r.ok ? "OK " : "FAIL";
    lines.push(`  [${tag}] ${r.file}${r.errors.length ? " — " + r.errors.join("; ") : ""}`);
  }
  for (const w of summary.files.flatMap((f) => f.warnings)) lines.push(`  warn: ${w}`);
  for (const e of summary.errors) lines.push(`  error: ${e}`);
  lines.push(summary.ok ? "validate-answers: PASS" : "validate-answers: FAIL");
  return { summary, printed: lines.join("\n") };
}