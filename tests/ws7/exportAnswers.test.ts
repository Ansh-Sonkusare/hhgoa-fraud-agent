import { describe, expect, it } from "vitest";
import { exportAnswerFile } from "../../eval/src/exportAnswers.js";
import { caseRun, exampleAnswer } from "./helpers.js";
import { AnswerFileSchema } from "../../contracts/src/index.js";

describe("exportAnswerFile", () => {
  it("is an identity projection for a well-formed answer", () => {
    const answer = exampleAnswer();
    const out = exportAnswerFile(caseRun("HHG-017", answer));
    expect(out.case_id).toBe("HHG-017");
    expect(out.next_best_actions.final).toEqual(answer.next_best_actions.final);
    expect(out.sar.file).toBe(true);
  });

  it("enforces the README legitimate-verdict rules", () => {
    const answer = exampleAnswer({
      case: {
        ...exampleAnswer().case,
        verdict: "legitimate",
        status: "closed_legitimate",
        fraud_probability: 0.1,
        pattern: "none",
        affected_txn_ids: ["3450629"],
        exposure_usd: 100,
      },
      sar: { file: true, reason: "x", narrative: "y", subjects: ["C04570"], total_amount_usd: 100, activity_dates: ["2020-01-01", "2020-01-02"] },
      next_best_actions: {
        initial: [{ action: "MONITOR_CARD", route: "auto", reason: "R10" }],
        final: [{ action: "MONITOR_CARD", route: "auto", reason: "R10" }],
        what_changed: "nothing",
      },
    });
    const out = exportAnswerFile(caseRun("HHG-017", answer));
    expect(out.case.verdict).toBe("legitimate");
    expect(out.case.affected_txn_ids).toEqual([]);
    expect(out.case.first_suspicious_txn_id).toBe("");
    expect(out.case.exposure_usd).toBe(0);
    expect(out.sar.file).toBe(false);
    expect(out.sar.narrative).toBe("");
    expect(out.sar.subjects).toEqual([]);
  });

  it("makes sar.file agree with FILE_REPORT presence", () => {
    const noReport = exampleAnswer({
      next_best_actions: {
        ...exampleAnswer().next_best_actions,
        final: [{ action: "BLOCK_CARD", route: "L1", reason: "R2" }],
      },
    });
    const out = exportAnswerFile(caseRun("HHG-017", noReport));
    expect(out.sar.file).toBe(false);
    expect(out.sar.narrative).toBe("");
  });

  it("keeps pattern_description only for undocumented patterns", () => {
    const undocumented = exampleAnswer({ case: { ...exampleAnswer().case, pattern: "undocumented", pattern_description: "" } });
    const out = exportAnswerFile(caseRun("HHG-017", undocumented));
    expect(out.case.pattern).toBe("undocumented");
    expect(out.case.pattern_description.length).toBeGreaterThan(2);
  });

  it("resets final to initial when no evidence was requested", () => {
    const answer = exampleAnswer({ evidence_requests: [] });
    const out = exportAnswerFile(caseRun("HHG-017", answer));
    expect(out.next_best_actions.what_changed).toBe("nothing");
    expect(out.next_best_actions.final).toEqual(out.next_best_actions.initial);
  });

  it("stamps measured latency and still passes the schema", () => {
    const out = exportAnswerFile(caseRun("HHG-017", exampleAnswer(), { latencyMs: 12500 }));
    expect(out.latency_s).toBeCloseTo(12.5);
    expect(() => AnswerFileSchema.parse(out)).not.toThrow();
  });
});