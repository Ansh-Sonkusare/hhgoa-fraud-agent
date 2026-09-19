import { describe, it, expect } from "vitest";
import {
  finalizeAssessment,
  fallbackAssessmentProposal,
  confidenceCap,
  applyContradictionCap,
  hasStrongContradiction,
  distinctEvidenceCategories,
  topFraudHypothesis,
  legitHypothesis,
  evidenceTopPattern,
  canonicalPattern,
} from "../../agent/src/assess.js";
import { MockLlmClient } from "../../agent/src/llm.js";
import { assess } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import type { EvidenceItem, EvidenceCategory } from "../../contracts/src/evidenceItem.js";

const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };
const EMPTY_EVIDENCE: EvidenceItem[] = [];

const item = (
  weight: number,
  contradicts: string[],
  category: EvidenceCategory = "txn_behavior",
): EvidenceItem => ({
  id: "ev_x",
  category,
  weight_hint: weight,
  source_tool: "get_transaction_history",
  supports: ["card_testing"],
  contradicts,
  summary: "s",
  entities: [{ type: "Transaction", id: "T1" }],
  ts: "2016-11-12T00:35:00Z",
});

function proposal(): AssessmentProposal {
  return {
    hypotheses: [
      { fraud_type: "card_testing", probability: 0.82, supporting: ["txn_behavior"], contradicting: [] },
      { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: ["txn_behavior"] },
    ],
    risk_level: "LOW",
    risk_score: 0.5,
    confidence: 0.8,
    legit_hypothesis_probability: 0.1,
  };
}

describe("finalizeAssessment", () => {
  it("always adds a legitimate hypothesis even when the model omits it", () => {
    const p = proposal();
    p.hypotheses = [{ fraud_type: "account_takeover", probability: 0.6, supporting: [], contradicting: [] }];
    const a = finalizeAssessment(p, EMPTY_EVIDENCE, SUFFICIENT);
    expect(legitHypothesis(a)).not.toBeNull();
  });

  it("normalizes probabilities to sum to 1 and re-derives the risk level", () => {
    const p = proposal();
    // Probabilities already sum to 1; the 0.9 top keeps CRITICAL after
    // normalization (scale would otherwise bleed the level down).
    p.hypotheses = [
      { fraud_type: "card_testing", probability: 0.9, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: [] },
    ];
    const a = finalizeAssessment(p, EMPTY_EVIDENCE, SUFFICIENT);
    const sum = a.hypotheses.reduce((s, h) => s + h.probability, 0);
    expect(sum).toBeCloseTo(1, 4);
    expect(a.risk_level).toBe("CRITICAL");
  });

  it("caps confidence by evidence-category count (no categories → 0.45)", () => {
    const a = finalizeAssessment(proposal(), EMPTY_EVIDENCE, SUFFICIENT);
    expect(confidenceCap(0)).toBe(0.45);
    expect(a.confidence).toBe(0.45);
  });

  it("uses the sufficiency block exactly as provided", () => {
    const suff = { sufficient: true, missing: [], stop_reason: "sufficient_evidence" };
    const a = finalizeAssessment(proposal(), EMPTY_EVIDENCE, suff);
    expect(a.sufficiency.sufficient).toBe(true);
    expect(a.sufficiency.stop_reason).toBe("sufficient_evidence");
  });
});

describe("contradiction rules", () => {
  it("hasStrongContradiction flags material weight against the top hypothesis", () => {
    expect(hasStrongContradiction([item(0.6, ["card_testing"])], "card_testing")).toBe(true);
    expect(hasStrongContradiction([item(0.2, ["card_testing"])], "card_testing")).toBe(false);
    expect(hasStrongContradiction([item(0.6, ["card_testing"])], "legitimate")).toBe(false);
  });

  it("applyContradictionCap downgrades one tier with a floor", () => {
    expect(applyContradictionCap(1, true)).toBe(0.65);
    expect(applyContradictionCap(0.65, true)).toBe(0.45);
    expect(applyContradictionCap(0.45, true)).toBe(0.45);
    expect(applyContradictionCap(0.45, false)).toBe(0.45);
  });
});

describe("hypothesis helpers", () => {
  it("topFraudHypothesis excludes legitimate and picks the highest", () => {
    const a = finalizeAssessment(proposal(), EMPTY_EVIDENCE, SUFFICIENT);
    expect(topFraudHypothesis(a)!.fraud_type).toBe("card_testing");
  });

  it("evidenceTopPattern weights by supports, ignoring fraud/legitimate", () => {
    const items = [
      item(0.7, []),
      { ...item(0.65, []), supports: ["card_testing"] },
      { ...item(0.2, []), supports: ["fraud"] },
    ];
    expect(evidenceTopPattern(items)).toBe("card_testing");
  });

  it("distinctEvidenceCategories counts unique categories", () => {
    const items = [
      item(0.7, []),
      item(0.65, [], "device_identity"),
      item(0.5, [], "txn_behavior"),
    ];
    expect(distinctEvidenceCategories(items).sort()).toEqual(["device_identity", "txn_behavior"]);
  });

  it("canonicalPattern maps onto the PatternSchema vocabulary", () => {
    expect(canonicalPattern("card_testing")).toBe("card_testing");
    expect(canonicalPattern("legitimate")).toBe("none");
    expect(canonicalPattern(null)).toBe("none");
    expect(canonicalPattern("made_up")).toBe("undocumented");
  });
});

describe("fallbackAssessmentProposal", () => {
  it("derives the probability from the trigger score and stays conservative", () => {
    const p = fallbackAssessmentProposal({ kind: "risk_score", risk_score: 0.78 }, EMPTY_EVIDENCE);
    expect(p.hypotheses[0]!.probability).toBeLessThanOrEqual(0.55);
    expect(p.confidence).toBe(0.5);
    expect(legitHypothesis(finalizeAssessment(p, EMPTY_EVIDENCE, SUFFICIENT))).not.toBeNull();
  });
});

describe("assess()", () => {
  it("runs model proposal through finalization, keeping sufficiency from the caller", async () => {
    const llm = new MockLlmClient([{ json: proposal() }]);
    const out = await assess({
      llm,
      systemPrompt: "sys",
      contextText: "ctx",
      trigger: { kind: "risk_score", risk_score: 0.78 },
      evidence: EMPTY_EVIDENCE,
      sufficiency: SUFFICIENT,
    });
    expect(out.structured.attempts).toBe(1);
    expect(out.assessment.confidence).toBeLessThanOrEqual(0.45);
    expect(out.assessment.sufficiency).toEqual(SUFFICIENT);
  });
})