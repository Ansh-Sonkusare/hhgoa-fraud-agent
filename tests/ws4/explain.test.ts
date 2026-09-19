import { describe, it, expect } from "vitest";
import { buildExplanation } from "../../agent/src/explain.js";
import { createFacts, type InvestigationFacts } from "../../agent/src/investigation.js";
import { finalizeAssessment } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";
import type { Recommendations } from "../../agent/src/recommend.js";
import type { PolicyActionName } from "../../contracts/src/answerFile.js";

const AS_OF = "2016-11-12T00:35:00Z";
const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };

function noRecommendations(): Recommendations {
  return {
    actions: [],
    intendedAction: null,
    intendedActionAllowed: false,
    why: {} as Record<PolicyActionName, string>,
  };
}

function facts(): InvestigationFacts {
  const f = createFacts("HHG-EX-1", AS_OF, { kind: "risk_score", risk_score: 0.78 });
  f.exposure_usd = 264.72;
  f.prior_cases = [{ case_id: "CC-0500", outcome: "confirmed_fraud", pattern: "card_testing" }];
  return f;
}

function assessment(top: number, legit: number, confidence: number) {
  return assessmentFrom([], top, legit, confidence);
}

function assessmentFrom(ev: EvidenceItem[], top: number, legit: number, confidence: number) {
  const p: AssessmentProposal = {
    hypotheses: [
      { fraud_type: "card_testing", probability: top, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: legit, supporting: [], contradicting: [] },
    ],
    risk_level: "MEDIUM",
    risk_score: 0.5,
    confidence,
    legit_hypothesis_probability: legit,
  };
  return finalizeAssessment(p, ev, SUFFICIENT);
}

const evidence: EvidenceItem[] = [
  {
    id: "ev_001",
    category: "txn_behavior",
    summary: "4 affected transactions within 2 hours on card C09001-K1 (exposure $264.72)",
    entities: [{ type: "Transaction", id: "9900001" }],
    source_tool: "get_transaction_history",
    weight_hint: 0.7,
    supports: ["card_testing"],
    contradicts: [],
    ts: AS_OF,
  },
];

// Three independent categories ⇒ confidence cap lifts (PRD §9.3), so the
// confident-decision explainer branch is reachable.
const fullEvidence: EvidenceItem[] = [
  evidence[0]!,
  { ...evidence[0]!, id: "ev_002", category: "device_identity", source_tool: "find_shared_entity_rings" },
  { ...evidence[0]!, id: "ev_003", category: "prior_cases", source_tool: "find_prior_cases" },
];

describe("buildExplanation", () => {
  it("lists evidence_used as id: truncated summary", () => {
    const ex = buildExplanation({
      facts: facts(),
      assessment: assessment(0.82, 0.1, 0.8),
      evidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: "sufficient_evidence",
    });
    expect(ex.evidence_used).toEqual([`ev_001: ${evidence[0]!.summary}`]);
  });

  it("states why more evidence was requested when an evidence request exists", () => {
    const ex = buildExplanation({
      facts: facts(),
      assessment: assessment(0.82, 0.1, 0.8),
      evidence,
      recommendations: noRecommendations(),
      evidenceRequests: [{ type: "customer_validation", assumed_response: "denied" }],
      stopReason: "sufficient_evidence",
    });
    expect(ex.why_more_evidence).toContain("below the 0.70 block threshold");
    expect(ex.why_more_evidence).toContain("customer_validation");
  });

  it("cites the stop reason when no evidence was requested but investigation stopped", () => {
    const ex = buildExplanation({
      facts: facts(),
      assessment: assessment(0.55, 0.4, 0.6),
      evidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: "budget_exhausted",
    });
    expect(ex.why_more_evidence).toContain('"budget_exhausted"');
  });

  it("explains what would change the decision for the strong, ambiguous, confirmed, and denied branches", () => {
    const strong = buildExplanation({
      facts: facts(),
      assessment: assessmentFrom(fullEvidence, 0.82, 0.1, 0.8),
      evidence: fullEvidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: "sufficient_evidence",
    });
    expect(strong.what_would_change_the_decision).toContain("cardholder made these purchases");

    const f2 = facts();
    const ambiguous = buildExplanation({
      facts: f2,
      assessment: assessment(0.55, 0.4, 0.6),
      evidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: null,
    });
    expect(ambiguous.what_would_change_the_decision).toContain("confidence above 0.75");

    const confirmed = buildExplanation({
      facts: { ...facts(), customer_confirmed: true },
      assessment: assessment(0.55, 0.4, 0.6),
      evidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: null,
    });
    expect(confirmed.what_would_change_the_decision).toContain("escalate to a block");

    const denied = buildExplanation({
      facts: { ...facts(), customer_denied: true },
      assessment: assessment(0.55, 0.4, 0.6),
      evidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: null,
    });
    expect(denied.what_would_change_the_decision).toContain("close as legitimate");
  });

  it("surfaces remaining uncertainty with the top hypothesis and similar cases", () => {
    const f = facts();
    f.similar_cases = [
      { case_id: "CC-0500", score: 0.9, outcome: "confirmed_fraud", overlap_reason: "same card" },
    ];
    const ex = buildExplanation({
      facts: f,
      assessment: assessmentFrom(fullEvidence, 0.9, 0.1, 0.8),
      evidence: fullEvidence,
      recommendations: noRecommendations(),
      evidenceRequests: [],
      stopReason: "sufficient_evidence",
    });
    expect(ex.remaining_uncertainty).toContain('"card_testing"');
    expect(ex.remaining_uncertainty).toContain("0.90");
    expect(ex.remaining_uncertainty).toContain("similar closed case (CC-0500@0.90)");
  });
})