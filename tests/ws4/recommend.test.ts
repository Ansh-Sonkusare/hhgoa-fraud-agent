import { describe, it, expect } from "vitest";
import { recommendActions, summarizeChange } from "../../agent/src/recommend.js";
import { createFacts, type InvestigationFacts } from "../../agent/src/investigation.js";
import { finalizeAssessment } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";

const AS_OF = "2016-11-12T00:35:00Z";
const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };

function baseFacts(): InvestigationFacts {
  const f = createFacts("HHG-REC-1", AS_OF, { kind: "risk_score", risk_score: 0.78 });
  f.txn_rows = [
    { txn_id: "9900001", ts: AS_OF, amount_usd: 1.5, product_cd: "W", channel: "online", risk_score: 0.2 },
    { txn_id: "9900004", ts: AS_OF, amount_usd: 259.98, product_cd: "C", channel: "online", risk_score: 0.57 },
  ];
  f.affected_txn_ids = ["9900001", "9900002", "9900003", "9900004"];
  f.exposure_usd = 264.72;
  // Shared device ring → sarRequired true (and MONITOR_CONNECTED_CARDS).
  f.rings = [
    { shared_type: "device", shared_id: "D000731", card_ids: ["C09001-K1", "C09002-K1"], community_id: "comm_017" },
  ];
  f.connected_card_ids = ["C09002-K1"];
  f.device_profiles = ["D000731"];
  f.prior_cases = [{ case_id: "CC-0500", outcome: "confirmed_fraud", pattern: "card_testing" }];
  return f;
}

function assess(top: number, legit = 0.1, confidence = 0.8, topType = "card_testing") {
  const proposal: AssessmentProposal = {
    hypotheses: [
      { fraud_type: topType, probability: top, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: legit, supporting: [], contradicting: [] },
    ],
    risk_level: "MEDIUM",
    risk_score: 0.5,
    confidence,
    legit_hypothesis_probability: legit,
  };
  return finalizeAssessment(proposal, [], SUFFICIENT);
}

describe("recommendActions", () => {
  it("high conviction with shared ring blocks the card, opens a case, files a SAR, and monitors connected cards", () => {
    const f = baseFacts();
    const recs = recommendActions(f, assess(0.82), []);
    const actions = recs.actions.map((a) => a.action);
    expect(actions).toContain("BLOCK_CARD");
    expect(actions).toContain("CREATE_CASE");
    expect(actions).toContain("FILE_REPORT");
    expect(actions).toContain("MONITOR_CONNECTED_CARDS");
    const block = recs.actions.find((a) => a.action === "BLOCK_CARD")!;
    expect(["L1", "L2"]).toContain(block.route);
    expect(recs.intendedAction!.action).toBe("BLOCK_CARD");
    expect(recs.intendedActionAllowed).toBe(true);
  });

  it("customer denial trumps a sub-threshold probability (policy 0.70 floor)", () => {
    const f = baseFacts();
    f.customer_denied = true;
    const recs = recommendActions(f, assess(0.55), []);
    expect(recs.actions.map((a) => a.action)).toContain("BLOCK_CARD");
  });

  it("ambiguous 0.55 lifts verification before enforcement and adds monitoring", () => {
    const f = baseFacts();
    f.exposure_usd = 120;
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), []);
    const actions = recs.actions.map((a) => a.action);
    expect(actions).toContain("VERIFY_WITH_CUSTOMER");
    expect(actions).toContain("MONITOR_CARD");
    expect(actions).not.toContain("BLOCK_CARD");
    expect(recs.intendedAction!.action).toBe("VERIFY_WITH_CUSTOMER");
  });

  it("uncertain with exposure over $500 escalates to an analyst", () => {
    const f = baseFacts();
    f.exposure_usd = 800;
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), []);
    expect(recs.actions.map((a) => a.action)).toContain("ESCALATE_TO_ANALYST");
  });

  it("legitimate pattern with sub-half probability allows the transaction and closes no-fraud", () => {
    const f = baseFacts();
    const recs = recommendActions(f, assess(0.2, 0.78, 0.8, "legitimate"), []);
    const actions = recs.actions.map((a) => a.action);
    expect(actions).toContain("ALLOW_TRANSACTION");
    expect(actions).toContain("CLOSE_NO_FRAUD");
    expect(actions).not.toContain("BLOCK_CARD");
  });

  it("summarizeChange describes the delta between initial and final action sets", () => {
    const f = baseFacts();
    const initial = recommendActions(f, assess(0.55, 0.4, 0.6), []).actions;
    f.customer_denied = true;
    const current = recommendActions(f, assess(0.55, 0.4, 0.6, "card_testing"), []).actions;
    const text = summarizeChange(initial, current, assess(0.55, 0.4, 0.6, "card_testing"), f);
    expect(text.length).toBeGreaterThan(0);
  });
})