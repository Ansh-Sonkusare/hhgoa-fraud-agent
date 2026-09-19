import { describe, it, expect } from "vitest";
import {
  planEvidenceGathering,
  VERIFICATION_BAND_ORDER,
  ANALYSIS_BAND_ORDER,
  ALL_EVIDENCE_REQUEST_TYPES,
  MIN_DISCRIMINATION,
} from "../../agent/src/planner.js";
import { finalizeAssessment } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import type { Assessment } from "../../contracts/src/assessment.js";
import type { EvidenceRequestType } from "../../contracts/src/answerFile.js";

const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };
const FRICTION: Record<EvidenceRequestType, number> = {
  customer_validation: 2,
  step_up_auth: 3,
  analyst_info: 1,
};

function proposal(top: number, legit: number, confidence = 0.6): AssessmentProposal {
  return {
    hypotheses: [
      { fraud_type: "card_testing", probability: top, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: legit, supporting: [], contradicting: [] },
    ],
    risk_level: "MEDIUM",
    risk_score: 0.5,
    confidence,
    legit_hypothesis_probability: legit,
  };
}

function assess(top: number, legit: number): Assessment {
  return finalizeAssessment(proposal(top, legit), [], SUFFICIENT);
}

function plan(
  assessment: Assessment,
  opts: { previouslyRequested?: EvidenceRequestType[]; band?: "verification" | "analysis" } = {},
) {
  return planEvidenceGathering({
    assessment,
    frictionCosts: FRICTION,
    allowedTypes: ALL_EVIDENCE_REQUEST_TYPES,
    previouslyRequested: opts.previouslyRequested ?? [],
    preferenceBand: opts.band,
  });
}

describe("planEvidenceGathering", () => {
  it("verification band prefers customer_validation even though analyst_info scores higher", () => {
    const a = assess(0.55, 0.4);
    const p = plan(a, { band: "verification" });
    expect(p.chosen!.type).toBe("customer_validation");
    const cv = p.scored.find((s) => s.type === "customer_validation")!;
    const ai = p.scored.find((s) => s.type === "analyst_info")!;
    expect(ai.score).toBeGreaterThan(cv.score);
    // discrimination = 1 − |a−b| over the *normalized* hypotheses
    // (documented deviation from the fixture's 0.42).
    const top = a.hypotheses.find((h) => h.fraud_type !== "legitimate")!.probability;
    const legit = a.legit_hypothesis_probability;
    expect(cv.discrimination).toBeCloseTo(1 - Math.abs(top - legit), 4);
    expect(cv.score).toBeCloseTo(Math.round((cv.discrimination / cv.friction_cost) * 1e4) / 1e4, 6);
  });

  it("analysis band prefers analyst_info and separates from the runner-up fraud hypothesis", () => {
    const p = plan(assess(0.55, 0.4), { band: "analysis" });
    expect(p.chosen!.type).toBe("analyst_info");
    expect(p.chosen!.separates).toEqual({ a: "card_testing", b: "legitimate" });
  });

  it("band order arrays are fixed and disjoint", () => {
    expect(VERIFICATION_BAND_ORDER).toEqual(["customer_validation", "step_up_auth", "analyst_info"]);
    expect(ANALYSIS_BAND_ORDER).toEqual(["analyst_info", "customer_validation", "step_up_auth"]);
    expect([...VERIFICATION_BAND_ORDER].sort()).toEqual([...ANALYSIS_BAND_ORDER].sort());
  });

  it("never requests a type already requested", () => {
    const p = plan(assess(0.55, 0.4), { band: "verification", previouslyRequested: ["customer_validation"] });
    expect(p.chosen).not.toBeNull();
    expect(p.chosen!.type).toBe("step_up_auth");
  });

  it("returns chosen null, with a reason, when every remaining type is below minDiscrimination", () => {
    // A near-flat 0.99/0.01 pair separates by only 0.02 (1 − |0.98|).
    const p = plan(assess(0.99, 0.01), { band: "analysis" });
    expect(p.scored.every((s) => s.discrimination < MIN_DISCRIMINATION)).toBe(true);
    expect(p.chosen).toBeNull();
    expect(p.reason).toContain("minimum discrimination");
  });
})