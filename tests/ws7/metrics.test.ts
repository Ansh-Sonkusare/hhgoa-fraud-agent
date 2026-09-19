import { describe, expect, it } from "vitest";
import { computeMetrics, scoreRun, agentEscalates, evidenceEval } from "../../eval/src/metrics.js";
import { exampleAnswer } from "./helpers.js";

function gold(id: string, outcome: "confirmed_fraud" | "cleared", pattern: string) {
  return { outcome, pattern };
}

describe("computeMetrics", () => {
  it("scores a perfect run as 1.0 across decision agreement and macro F1", () => {
    const fraud = exampleAnswer({ case: { ...exampleAnswer().case, verdict: "fraud", pattern: "card_testing" } });
    const fast = exampleAnswer({ case: { ...exampleAnswer().case, verdict: "fraud", pattern: "card_not_present_fraud" } });
    const legit = exampleAnswer({
      case: { ...exampleAnswer().case, verdict: "legitimate", pattern: "none", status: "closed_legitimate" },
      next_best_actions: {
        initial: [{ action: "MONITOR_CARD", route: "auto", reason: "R10" }],
        final: [{ action: "MONITOR_CARD", route: "auto", reason: "R10" }],
        what_changed: "nothing",
      },
    });
    const runs = [
      scoreRun("a", gold("a", "confirmed_fraud", "card_testing"), fraud, 8, 10_000, 15_000),
      scoreRun("b", gold("b", "confirmed_fraud", "card_not_present_fraud"), fast, 7, 9_000, 20_000),
      scoreRun("c", gold("c", "cleared", "refund_abuse"), legit, 5, 7_000, 10_000),
    ];
    const m = computeMetrics(runs, 0.004);
    expect(m.n).toBe(3);
    expect(m.decisionAgreement).toBe(1);
    expect(m.patternF1.macro).toBeCloseTo(1);
    expect(m.patternAccuracy).toBe(1);
    expect(m.falseBlockRate).toBe(0);
    expect(m.avgToolCalls).toBeCloseTo(20 / 3);
    expect(m.costUsd).toBeCloseTo((26_000 / 1000) * 0.004);
  });

  it("penalizes a wrong pattern on a confirmed case", () => {
    const wrong = exampleAnswer({ case: { ...exampleAnswer().case, verdict: "fraud", pattern: "account_takeover" } });
    const runs = [
      scoreRun("a", gold("a", "confirmed_fraud", "card_testing"), wrong, 9, 10_000, 15_000),
      scoreRun("b", gold("b", "confirmed_fraud", "account_takeover"), wrong, 8, 9_000, 18_000),
    ];
    const m = computeMetrics(runs);
    expect(m.patternAccuracy).toBe(0.5);
    expect(m.patternF1.macro).toBeLessThan(1);
    expect(m.decisionAgreement).toBe(1);
  });

  it("flags an escalation on a cleared case as a false block", () => {
    const overBlock = exampleAnswer({ case: { ...exampleAnswer().case, verdict: "fraud", pattern: "card_testing" } });
    const runs = [scoreRun("c", gold("c", "cleared", "refund_abuse"), overBlock, 8, 8_000, 12_000)];
    const m = computeMetrics(runs);
    expect(m.falseBlockRate).toBe(1);
    expect(m.decisionAgreement).toBe(0);
  });
});

describe("agentEscalates", () => {
  it("treats fraud verdict and L1/L2 routes as escalation; monitors are not", () => {
    const fraud = exampleAnswer();
    expect(agentEscalates(fraud)).toBe(true);
    const legit = exampleAnswer({
      case: { ...exampleAnswer().case, verdict: "legitimate", pattern: "none", status: "closed_legitimate" },
      next_best_actions: {
        initial: [{ action: "MONITOR_CARD", route: "auto", reason: "R10" }],
        final: [{ action: "MONITOR_CARD", route: "auto", reason: "R10" }],
        what_changed: "nothing",
      },
    });
    expect(agentEscalates(legit)).toBe(false);
  });
});

describe("evidenceEval", () => {
  it("reports whether the final decision changed after evidence requests", () => {
    const changed = exampleAnswer();
    expect(evidenceEval(changed).changed).toBe(true);
    const unchanged = exampleAnswer({
      next_best_actions: {
        initial: [{ action: "BLOCK_CARD", route: "L1", reason: "R2" }],
        final: [{ action: "BLOCK_CARD", route: "L1", reason: "R2" }],
        what_changed: "nothing",
      },
    });
    expect(evidenceEval(unchanged).changed).toBe(false);
  });
});