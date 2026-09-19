import { describe, it, expect } from "vitest";
import {
  evaluateStop,
  describeEvaluateStop,
  probabilityLead,
  categoriesOk,
  confidenceOk,
} from "../../agent/src/stopRule.js";
import { finalizeAssessment, canonicalPattern } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import type { Assessment } from "../../contracts/src/assessment.js";

const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };

function proposal(top: number, legit: number, confidence: number, topType = "card_testing"): AssessmentProposal {
  return {
    hypotheses: [
      { fraud_type: topType, probability: top, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: legit, supporting: [], contradicting: [] },
    ],
    risk_level: "MEDIUM",
    risk_score: 0.5,
    confidence,
    legit_hypothesis_probability: legit,
  };
}

function assess(top: number, legit: number, confidence: number): Assessment {
  return finalizeAssessment(proposal(top, legit, confidence), [], SUFFICIENT);
}

import type { NextBestAction } from "../../contracts/src/answerFile.js";

const allowed: NextBestAction = { action: "BLOCK_CARD", route: "auto", reason: "r" };
const notAllowed: NextBestAction = { action: "BLOCK_CARD", route: "L1", reason: "r" };

const cats = ["txn_behavior", "device_identity", "prior_cases"] as ("txn_behavior" | "device_identity" | "prior_cases")[];

describe("evaluateStop", () => {
  it("budget exhaustion always stops, regardless of everything else", () => {
    expect(
      evaluateStop({
        assessment: assess(0.82, 0.1, 0.8),
        categories: cats,
        allCategoriesExhausted: false,
        intendedAction: allowed,
        intendedActionAllowed: true,
        budgetExhausted: true,
        noDiscriminatingEvidence: false,
      }),
    ).toEqual({ stop: true, reason: "budget_exhausted" });
  });

  it("stops as sufficient when 3+ categories, strong lead, and the action is allowed", () => {
    const d = evaluateStop({
      assessment: assess(0.82, 0.1, 0.8),
      categories: cats,
      allCategoriesExhausted: false,
      intendedAction: allowed,
      intendedActionAllowed: true,
      budgetExhausted: false,
      noDiscriminatingEvidence: false,
    });
    expect(d).toEqual({ stop: true, reason: "sufficient_evidence" });
  });

  it("does not stop while the lead is below threshold, no categories are exhausted, and evidence remains", () => {
    const d = evaluateStop({
      assessment: assess(0.55, 0.4, 0.6),
      categories: cats,
      allCategoriesExhausted: false,
      intendedAction: allowed,
      intendedActionAllowed: true,
      budgetExhausted: false,
      noDiscriminatingEvidence: false,
    });
    expect(d).toEqual({ stop: false, reason: null });
  });

  it("stops with no_discriminating_evidence_available when nothing new can separate the hypotheses", () => {
    const d = evaluateStop({
      assessment: assess(0.55, 0.4, 0.6),
      categories: cats,
      allCategoriesExhausted: true,
      intendedAction: allowed,
      intendedActionAllowed: true,
      budgetExhausted: false,
      noDiscriminatingEvidence: true,
    });
    expect(d.reason).toBe("no_discriminating_evidence_available");
  });

  it("requires a human for L1/L2 actions whose prerequisites hygiene isn't met", () => {
    const d = evaluateStop({
      assessment: assess(0.82, 0.1, 0.8),
      categories: cats,
      allCategoriesExhausted: true,
      intendedAction: notAllowed,
      intendedActionAllowed: false,
      budgetExhausted: false,
      noDiscriminatingEvidence: true,
    });
    expect(d).toEqual({ stop: true, reason: "policy_requires_human" });
  });
});

describe("probability helpers", () => {
  it("probabilityLead returns |top − runner-up| on normalized probabilities", () => {
    expect(probabilityLead(assess(0.9, 0.1, 0.8))).toBeCloseTo(0.8, 3);
  });
  it("categoriesOk needs 3+ categories or exhaustion", () => {
    expect(categoriesOk(cats, false)).toBe(true);
    expect(categoriesOk(["txn_behavior"] as typeof cats, false)).toBe(false);
    expect(categoriesOk(["txn_behavior"] as typeof cats, true)).toBe(true);
  });
  it("confidenceOk passes on strong lead even with low model confidence", () => {
    expect(confidenceOk(assess(0.82, 0.1, 0.4))).toBe(true);
    expect(confidenceOk(assess(0.55, 0.4, 0.6))).toBe(false);
  });
});

describe("describeEvaluateStop", () => {
  const dec = (reason: "budget_exhausted" | "policy_requires_human" | "sufficient_evidence") =>
    ({ stop: true, reason: reason }) as const;

  it("reads the sufficient branch with number-word categories for 3 categories", () => {
    const input = {
      assessment: assess(0.9, 0.1, 0.8),
      categories: cats,
      allCategoriesExhausted: false,
      intendedAction: allowed,
      intendedActionAllowed: true,
      budgetExhausted: false,
      noDiscriminatingEvidence: false,
    } as const;
    const text = describeEvaluateStop(input, evaluateStop(input));
    expect(text).toContain("three independent evidence categories");
    expect(text).toContain("txn_behavior, device_identity, prior_cases");
    expect(text).toContain("0.75 confidence threshold");
  });

  it("customer denial has its own branch wording under a sufficient stop", () => {
    const input = {
      assessment: assess(0.9, 0.1, 0.8),
      categories: cats,
      allCategoriesExhausted: false,
      intendedAction: allowed,
      intendedActionAllowed: true,
      budgetExhausted: false,
      noDiscriminatingEvidence: false,
      customerDenied: true,
    } as const;
    expect(evaluateStop(input)).toEqual({ stop: true, reason: "sufficient_evidence" });
    expect(describeEvaluateStop(input, evaluateStop(input))).toContain("Customer denial settled the verdict");
  });

  it("describes budget and policy-requires-human reasons", () => {
    const input = {
      assessment: assess(0.82, 0.1, 0.8),
      categories: cats,
      allCategoriesExhausted: false,
      intendedAction: notAllowed,
      intendedActionAllowed: true,
      budgetExhausted: true,
      noDiscriminatingEvidence: false,
    } as const;
    expect(describeEvaluateStop(input, dec("budget_exhausted"))).toContain("runaway tool calls");

    const policyInput = {
      assessment: assess(0.82, 0.1, 0.8),
      categories: cats,
      allCategoriesExhausted: false,
      intendedAction: notAllowed,
      intendedActionAllowed: false,
      budgetExhausted: false,
      noDiscriminatingEvidence: true,
    } as const;
    expect(evaluateStop(policyInput)).toEqual({ stop: true, reason: "policy_requires_human" });
    expect(describeEvaluateStop(policyInput, evaluateStop(policyInput))).toContain("human sign-off");
  });
});

it("canonicalPattern maps unknown fraud types onto the PatternSchema vocabulary", () => {
  expect(canonicalPattern("card_testing")).toBe("card_testing");
  expect(canonicalPattern("legitimate")).toBe("none");
  expect(canonicalPattern("made_up_pattern")).toBe("undocumented");
})