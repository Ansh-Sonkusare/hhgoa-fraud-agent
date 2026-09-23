import { describe, it, expect } from "vitest";
import { recommendActions, summarizeChange } from "../../agent/src/recommend.js";
import { createFacts, type InvestigationFacts } from "../../agent/src/investigation.js";
import { finalizeAssessment } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import { runAgent, createLlmClient } from "../../agent/src/agentFactory.js";
import type { MockScriptEntry } from "../../agent/src/llm.js";

// README §3b: recommend what the evidence supports, ask when the policy calls
// for it, then recommend again. With no cardholder reply available (§5), R4
// ("no reply") governs the second recommendation; nothing is assumed about
// what the cardholder would have said.

const AS_OF = "2016-11-12T00:35:00Z";

function facts(exposure: number): InvestigationFacts {
  const f = createFacts("HHG-VF-1", AS_OF, { kind: "risk_score", risk_score: 0.78 });
  f.txn_rows = [{ txn_id: "9900004", ts: AS_OF, amount_usd: exposure, product_cd: "C", channel: "online", risk_score: 0.57 }];
  f.affected_txn_ids = ["9900004"];
  f.exposure_usd = exposure;
  return f;
}

function assessment(p: number, confidence = 0.6) {
  const proposal: AssessmentProposal = {
    hypotheses: [
      { fraud_type: "card_not_present_fraud", probability: p, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: 1 - p, supporting: [], contradicting: [] },
    ],
    risk_level: "MEDIUM",
    risk_score: p,
    confidence,
    legit_hypothesis_probability: 1 - p,
  };
  return finalizeAssessment(proposal, [], { sufficient: false, missing: [], stop_reason: null });
}

const names = (xs: { action: string }[]) => xs.map((a) => a.action);

describe("R1 verification, then R4 on no reply", () => {
  it("initially verifies, monitors and opens a case (§3a: p >= 0.30)", () => {
    const recs = recommendActions(facts(120), assessment(0.6), [], "uncertain");
    expect(names(recs.actions)).toEqual(expect.arrayContaining(["VERIFY_WITH_CUSTOMER", "MONITOR_CARD", "CREATE_CASE"]));
    expect(names(recs.actions)).not.toContain("BLOCK_CARD");
    // The decision is the verification, not the case bookkeeping.
    expect(recs.intendedAction!.action).toBe("VERIFY_WITH_CUSTOMER");
  });

  it("after an unanswered request, R4 governs: monitor, keep the case, no second verify, invent no decline", () => {
    const f = facts(120);
    f.verification_unanswered = true;
    const recs = recommendActions(f, assessment(0.6), [], "uncertain");
    expect(names(recs.actions)).toEqual(expect.arrayContaining(["MONITOR_CARD", "CREATE_CASE"]));
    expect(names(recs.actions)).not.toContain("VERIFY_WITH_CUSTOMER");
    expect(names(recs.actions)).not.toContain("DECLINE_TRANSACTION");
    expect(recs.actions.find((a) => a.action === "MONITOR_CARD")!.reason).toMatch(/^R4: /);
  });

  it("R4 escalates an unanswered case over $500", () => {
    const f = facts(640);
    f.verification_unanswered = true;
    const recs = recommendActions(f, assessment(0.6), [], "uncertain");
    expect(recs.actions.find((a) => a.action === "ESCALATE_TO_ANALYST")!.reason).toContain("R4 and R8");
  });

  it("what_changed says a reply was asked for, none came, and R4 now governs", () => {
    const initial = recommendActions(facts(120), assessment(0.6), [], "uncertain");
    const f = facts(120);
    f.verification_unanswered = true;
    const final = recommendActions(f, assessment(0.6), [], "uncertain");
    const text = summarizeChange(initial.actions, final.actions, assessment(0.6), f, [{ type: "customer_validation" }]);
    expect(text).toContain("no reply was received and none was assumed");
    expect(text).toContain("R4");
    expect(text).toContain("dropped VERIFY_WITH_CUSTOMER");
  });

  it("a low-probability case at p >= 0.30 still opens a case", () => {
    const recs = recommendActions(facts(40), assessment(0.32), [], "uncertain");
    expect(names(recs.actions)).toContain("CREATE_CASE");
  });
});

function script(p: number, confidence: number): MockScriptEntry[] {
  return [
    {
      json: {
        hypotheses: [
          { fraud_type: "card_testing", probability: p, supporting: [], contradicting: [] },
          { fraud_type: "legitimate", probability: 1 - p, supporting: [], contradicting: [] },
        ],
        risk_level: "MEDIUM",
        risk_score: p,
        confidence,
        legit_hypothesis_probability: 1 - p,
      },
    },
  ];
}

describe("machine: a case in the verification band asks before it stops", () => {
  it("requests customer validation even when the stop rule is satisfied, then files R4's recommendation", async () => {
    // Confidence 0.8 satisfies the stop rule on the first pass; README §6 still
    // does not let a p = 0.65 case stop until the cardholder has been asked.
    const r = await runAgent({
      caseId: "HHG-VF-2",
      asOf: AS_OF,
      trigger: { kind: "risk_score", risk_score: 0.78 },
      llm: createLlmClient("mock", script(0.65, 0.8)),
      backend: "fake",
      calibrateAlerts: false,
    });
    expect(r.answer.evidence_requests.map((q) => q.type)).toEqual(["customer_validation"]);
    expect(names(r.answer.next_best_actions.initial)).toContain("VERIFY_WITH_CUSTOMER");
    expect(names(r.answer.next_best_actions.final)).not.toContain("VERIFY_WITH_CUSTOMER");
    expect(names(r.answer.next_best_actions.final)).toContain("CREATE_CASE");
    expect(r.answer.next_best_actions.what_changed).toContain("R4");
    expect(r.answer.stop_reason).toContain("no reply is available");
    expect(r.answer.case.verdict).toBe("uncertain");
  });

  it("does not ask when the case is already decisive (p >= 0.85)", async () => {
    const r = await runAgent({
      caseId: "HHG-VF-3",
      asOf: AS_OF,
      trigger: { kind: "risk_score", risk_score: 0.78 },
      llm: createLlmClient("mock", script(0.92, 0.9)),
      backend: "fake",
      calibrateAlerts: false,
    });
    expect(r.answer.evidence_requests).toEqual([]);
    expect(r.answer.next_best_actions.what_changed).toBe("nothing");
  });
});
