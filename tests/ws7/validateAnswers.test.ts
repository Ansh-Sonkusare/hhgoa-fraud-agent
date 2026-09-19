import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadIdIndex } from "../../eval/src/dataset.js";
import { validateAnswerFile, validateCaseFile, validateAnswersDir, runValidation } from "../../eval/src/validateAnswers.js";
import { exampleAnswer } from "./helpers.js";
import { repoRoot } from "../../eval/src/env.js";

const index = await loadIdIndex(path.join(repoRoot(), "data"));

function validAnswer() {
  return exampleAnswer();
}

function writeCase(dir: string, id: string, obj: unknown) {
  const p = path.join(dir, `${id}.json`);
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

describe("validateAnswerFile", () => {
  it("passes a well-formed HGO answer on the real dataset index", () => {
    const warnings: string[] = [];
    const errors = validateAnswerFile(validAnswer(), index, "HHG-017.json", warnings);
    expect(errors).toEqual([]);
  });

  it("rejects a legitimate verdict while still listing affected txns or SAR", () => {
    const bad = exampleAnswer({
      case: { ...exampleAnswer().case, verdict: "legitimate", status: "closed_legitimate", affected_txn_ids: ["3450629"], exposure_usd: 10 },
      sar: { ...exampleAnswer().sar, file: true },
    });
    const warnings: string[] = [];
    const errors = validateAnswerFile(bad, index, "x.json", warnings);
    expect(errors.some((e) => e.startsWith("legitimate verdict but affected_txn_ids"))).toBe(true);
    expect(errors.some((e) => e.startsWith("legitimate verdict but exposure_usd"))).toBe(true);
    expect(errors.some((e) => e.startsWith("legitimate verdict but sar.file"))).toBe(true);
  });

  it("rejects unknown transaction, card, and closed-case references", () => {
    const bad = exampleAnswer({
      case: {
        ...exampleAnswer().case,
        affected_txn_ids: ["0000000000"],
        connected_card_ids: ["NO-SUCH-CARD-K1"],
        similar_prior_cases: ["CC-9999"],
      },
    });
    const warnings: string[] = [];
    const errors = validateAnswerFile(bad, index, "x.json", warnings);
    expect(errors.join("\n")).toContain("unknown transaction");
    expect(errors.join("\n")).toContain("unknown card");
    expect(errors.join("\n")).toContain("unknown closed case");
  });

  it("flags sar/agreement and undocumented-pattern violations", () => {
    const noReport = exampleAnswer({
      sar: { ...exampleAnswer().sar, file: true },
      next_best_actions: {
        ...exampleAnswer().next_best_actions,
        final: [{ action: "BLOCK_CARD", route: "L1", reason: "R2" }],
      },
    });
    const warnings1: string[] = [];
    const byAgreement = validateAnswerFile(noReport, index, "x.json", warnings1);
    expect(byAgreement.join("\n")).toContain("does not agree with FILE_REPORT");

    const undocumented = exampleAnswer({
      case: { ...exampleAnswer().case, pattern: "undocumented", pattern_description: "" },
    });
    const warnings2: string[] = [];
    const errors = validateAnswerFile(undocumented, index, "x.json", warnings2);
    expect(errors.join("\n")).toContain("pattern undocumented but pattern_description is empty");
  });
});

describe("validateCaseFile / validateAnswersDir", () => {
  it("parses schema, catches error markers, and counts pass/fail in a directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws7-"));
    writeCase(dir, "HHG-017", validAnswer());
    writeCase(dir, "HHG-002", { case: "not-an-answer" });

    const summary = validateAnswersDir(dir, index, {});
    expect(summary.caseCount).toBe(2);
    expect(summary.ok).toBe(false);
    const files = summary.files.sort((a, b) => a.file.localeCompare(b.file));
    const valid = files.find((f) => f.file.endsWith("HHG-017.json"))!;
    expect(valid.ok).toBe(true);
    expect(files.some((f) => !f.ok)).toBe(true);

    const marker = writeCase(dir, "HHG-003", { error: true, message: "timeout" });
    const report = validateCaseFile(marker, index, {});
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain("run error marker");
  });

  it("reports missing expected answer files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws7-"));
    writeCase(dir, "HHG-017", validAnswer());
    const expectIds = new Set(["HHG-017", "HHG-002"]);
    const summary = validateAnswersDir(dir, index, { expectCaseIds: expectIds });
    expect(summary.ok).toBe(false);
    expect(summary.errors.some((e) => e.includes("missing answer files"))).toBe(true);
  });

  it("runValidation prints PASS/FAIL with exit signal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws7-"));
    writeCase(dir, "HHG-017", validAnswer());
    const { summary, printed } = runValidation(dir, index, { expectCaseIds: new Set(["HHG-017"]) });
    expect(summary.ok).toBe(true);
    expect(printed).toContain("validate-answers: PASS");
  });
});