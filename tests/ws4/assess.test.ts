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
// ---------------------------------------------------------------------------
// Two-stage assessor: calibration must always be handed a fraud hypothesis.
//
// Regression for bt_iter1b: on thin briefs the 7B triage marked every fraud
// pattern fits=false and `legitimate` fits=true, renderTriageForCalibration
// kept only the fitting candidates, calibration never saw a fraud alternative,
// and finalizeAssessment read the top fraud probability as exactly 0 ->
// `legitimate`/`none`. Three confirmed-fraud cases (CC-4386, CC-2247, CC-5194)
// became false negatives in one 20-case run; the single-stage assessor, whose
// schema always carried both, had 0/17. The fix is on the evidence side --
// the best-supported fraud candidate is always rendered, flagged as
// un-endorsed -- never on the 0.4 legitimate threshold.
// ---------------------------------------------------------------------------
import { renderTriageForCalibration } from "../../agent/src/assess.js";
import type { TriageProposal } from "../../agent/src/assess.js";

const ev = (id: string, supports: string[]): EvidenceItem => ({
  id,
  category: "txn_behavior",
  weight_hint: 0.5,
  source_tool: "get_transaction_history",
  supports,
  contradicts: [],
  summary: `summary ${id}`,
  entities: [{ type: "Transaction", id: "T1" }],
  ts: "2016-11-12T00:35:00Z",
});
const POOL: EvidenceItem[] = [
  ev("ev_a", ["card_not_present_fraud"]),
  ev("ev_b", ["card_not_present_fraud"]),
  ev("ev_c", ["legitimate"]),
];

describe("renderTriageForCalibration always scores a fraud hypothesis", () => {
  it("adds the best-supported fraud candidate when only `legitimate` fits, flagged as un-endorsed", () => {
    const triage: TriageProposal = {
      candidates: [
        { fraud_type: "legitimate", fits: true, supporting: ["ev_c"], contradicting: [] },
        { fraud_type: "card_testing", fits: false, supporting: ["ev_a"], contradicting: [] },
        { fraud_type: "card_not_present_fraud", fits: false, supporting: ["ev_a", "ev_b"], contradicting: [] },
      ],
    };
    const brief = renderTriageForCalibration(triage, POOL);
    expect(brief).toContain("Hypothesis: legitimate");
    expect(brief).toContain("Hypothesis: card_not_present_fraud (triage did not mark this as fitting");
    expect(brief).not.toContain("Hypothesis: card_testing");
    // the un-endorsed candidate still carries its real evidence for calibration to weigh
    expect(brief).toContain("ev_a (txn_behavior");
    expect(brief).toContain("ev_b (txn_behavior");
  });

  it("does not add or flag anything when a fraud candidate already fits", () => {
    const triage: TriageProposal = {
      candidates: [
        { fraud_type: "legitimate", fits: true, supporting: ["ev_c"], contradicting: [] },
        { fraud_type: "card_not_present_fraud", fits: true, supporting: ["ev_a"], contradicting: [] },
        { fraud_type: "card_testing", fits: false, supporting: ["ev_b"], contradicting: [] },
      ],
    };
    const brief = renderTriageForCalibration(triage, POOL);
    expect(brief).toContain("Hypothesis: card_not_present_fraud\n");
    expect(brief).not.toContain("triage did not mark this as fitting");
    expect(brief).not.toContain("Hypothesis: card_testing");
  });

  it("renders every candidate when nothing fits (unchanged behaviour), without the flag", () => {
    const triage: TriageProposal = {
      candidates: [
        { fraud_type: "legitimate", fits: false, supporting: [], contradicting: [] },
        { fraud_type: "card_testing", fits: false, supporting: ["ev_a"], contradicting: [] },
      ],
    };
    const brief = renderTriageForCalibration(triage, POOL);
    expect(brief).toContain("Hypothesis: legitimate");
    expect(brief).toContain("Hypothesis: card_testing");
    expect(brief).not.toContain("triage did not mark this as fitting");
  });

  it("is a no-op when triage offered no fraud candidate at all", () => {
    const triage: TriageProposal = {
      candidates: [{ fraud_type: "legitimate", fits: true, supporting: ["ev_c"], contradicting: [] }],
    };
    const brief = renderTriageForCalibration(triage, POOL);
    expect(brief).toContain("Hypothesis: legitimate");
    expect(brief).not.toContain("triage did not mark this as fitting");
  });
});

describe("assess() stage count", () => {
  const base = {
    systemPrompt: "sys",
    triageSystemPrompt: "triage",
    calibrateSystemPrompt: "calibrate",
    contextText: "ctx",
    trigger: { kind: "risk_score" as const, risk_score: 0.78 },
    evidence: EMPTY_EVIDENCE,
    sufficiency: SUFFICIENT,
  };

  it("default (stages omitted) makes exactly one LLM call and never sends the triage prompt", async () => {
    const llm = new MockLlmClient([{ json: proposal() }]);
    await assess({ llm, ...base });
    expect(llm.callCount).toBe(1);
  });

  it("stages: 1 makes exactly one call", async () => {
    const llm = new MockLlmClient([{ json: proposal() }]);
    await assess({ llm, stages: 1, ...base });
    expect(llm.callCount).toBe(1);
  });

  it("stages: 2 makes two calls (triage, then calibration)", async () => {
    const triage = { candidates: [{ fraud_type: "card_testing", fits: true, supporting: [], contradicting: [] }] };
    const llm = new MockLlmClient([{ json: triage }, { json: proposal() }]);
    await assess({ llm, stages: 2, ...base });
    expect(llm.callCount).toBe(2);
  });
});

import { fraudProbability } from "../../agent/src/assess.js";
import { isLegitVerdict } from "../../agent/src/caseState.js";
import type { Assessment } from "../../contracts/src/index.js";

describe("fraudProbability is the total fraud mass, not the top pattern's share", () => {
  const hyp = (fraud_type: string, probability: number) => ({ fraud_type, probability, supporting: [] as string[], contradicting: [] as string[] });
  const full = (p: Pick<Assessment, "hypotheses" | "legit_hypothesis_probability">): Assessment => ({
    ...p,
    risk_level: "MEDIUM",
    risk_score: 0.5,
    confidence: 0.5,
    sufficiency: { sufficient: false, missing: [], stop_reason: null },
  });
  // The real CC-5475 (gold account_takeover) split: 80% fraud across three
  // patterns. Reading only the top type (0.35) closed it `legitimate`.
  const split: Pick<Assessment, "hypotheses" | "legit_hypothesis_probability"> = {
    hypotheses: [hyp("account_takeover", 0.35), hyp("out_of_region_use", 0.25), hyp("card_not_present_fraud", 0.2), hyp("legitimate", 0.2)],
    legit_hypothesis_probability: 0.2,
  };

  it("sums every non-legitimate hypothesis", () => {
    expect(fraudProbability(split)).toBeCloseTo(0.8, 6);
  });

  it("a hedge between fraud patterns is not a legitimate verdict", () => {
    expect(isLegitVerdict(full(split))).toBe(false);
  });

  it("a genuinely legitimate assessment still reads low", () => {
    const legit = { hypotheses: [hyp("card_testing", 0.1), hyp("legitimate", 0.9)], legit_hypothesis_probability: 0.9 };
    expect(fraudProbability(legit)).toBeCloseTo(0.1, 6);
    expect(isLegitVerdict(full(legit))).toBe(true);
  });

  it("with no fraud hypothesis, it is 1 - legitimate, never the legitimate mass itself", () => {
    // Certain-legitimate files the lower bound, never the legitimate mass (1).
    expect(fraudProbability({ hypotheses: [hyp("legitimate", 1)], legit_hypothesis_probability: 1 })).toBe(0.01);
  });

  it("never files certainty: all mass on fraud reads 0.99, not 1 (HHG-014)", () => {
    expect(
      fraudProbability({
        hypotheses: [hyp("card_not_present_new_device", 0.87), hyp("account_takeover", 0.13), hyp("legitimate", 0)],
        legit_hypothesis_probability: 0,
      }),
    ).toBe(0.99);
  });

  it("leaves probabilities inside the bounds unchanged", () => {
    expect(
      fraudProbability({ hypotheses: [hyp("card_testing", 0.7), hyp("legitimate", 0.3)], legit_hypothesis_probability: 0.3 }),
    ).toBeCloseTo(0.7, 10);
  });
});
