import { describe, it, expect } from "vitest";
import { recommendActions, summarizeChange } from "../../agent/src/recommend.js";
import { createFacts, type InvestigationFacts } from "../../agent/src/investigation.js";
import { finalizeAssessment, fraudProbability } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";

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
    const recs = recommendActions(f, assess(0.82), [], "fraud");
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
    const recs = recommendActions(f, assess(0.55), [], "uncertain");
    expect(recs.actions.map((a) => a.action)).toContain("BLOCK_CARD");
  });

  it("ambiguous 0.55 lifts verification before enforcement and adds monitoring", () => {
    const f = baseFacts();
    f.exposure_usd = 120;
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), [], "uncertain");
    const actions = recs.actions.map((a) => a.action);
    expect(actions).toContain("VERIFY_WITH_CUSTOMER");
    expect(actions).toContain("MONITOR_CARD");
    expect(actions).not.toContain("BLOCK_CARD");
    expect(recs.intendedAction!.action).toBe("VERIFY_WITH_CUSTOMER");
  });

  it("uncertain with exposure over $500 escalates to an analyst", () => {
    const f = baseFacts();
    f.exposure_usd = 800;
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), [], "uncertain");
    expect(recs.actions.map((a) => a.action)).toContain("ESCALATE_TO_ANALYST");
  });

  it("a legitimate reading closes only on the cardholder's confirmation (R3)", () => {
    // A genuinely legitimate assessment names no fraud hypothesis at all and
    // holds a high probability for `legitimate`; fraud probability is its
    // complement. The shared assess() helper always emits two hypotheses, so
    // build this one directly.
    const legitOnly = finalizeAssessment(
      {
        hypotheses: [{ fraud_type: "legitimate", probability: 1, supporting: [], contradicting: [] }],
        risk_level: "LOW",
        risk_score: 0.2,
        confidence: 0.8,
        legit_hypothesis_probability: 1,
      },
      [],
      SUFFICIENT,
    );
    const names = (f: ReturnType<typeof baseFacts>) =>
      recommendActions(f, legitOnly, [], "legitimate").actions.map((a) => a.action);

    // Confirmed: R3 allows and closes. p = 0 is below §3a's 0.30 line: no case.
    const confirmed = baseFacts();
    confirmed.customer_confirmed = true;
    expect(names(confirmed)).toEqual(expect.arrayContaining(["ALLOW_TRANSACTION", "CLOSE_NO_FRAUD"]));
    expect(names(confirmed)).not.toContain("CREATE_CASE");
    expect(names(confirmed)).not.toContain("BLOCK_CARD");

    // Not yet asked: ask first. Closing on the evidence alone was measured to
    // close confirmed fraud, so nothing is closed or allowed here; §3a opens a
    // case because evidence is requested.
    const unasked = names(baseFacts());
    expect(unasked).toEqual(expect.arrayContaining(["VERIFY_WITH_CUSTOMER", "MONITOR_CARD", "CREATE_CASE"]));
    expect(unasked).not.toContain("CLOSE_NO_FRAUD");
    expect(unasked).not.toContain("ALLOW_TRANSACTION");
    expect(unasked).not.toContain("BLOCK_CARD");

    // Asked, no reply: R4 monitoring, still not closed.
    const noReply = baseFacts();
    noReply.verification_unanswered = true;
    const after = names(noReply);
    expect(after).toEqual(expect.arrayContaining(["MONITOR_CARD", "CREATE_CASE"]));
    expect(after).not.toContain("VERIFY_WITH_CUSTOMER");
    expect(after).not.toContain("CLOSE_NO_FRAUD");
    expect(after).not.toContain("ALLOW_TRANSACTION");
  });

  it("R4: no reply declines the flagged authorization (L1) and monitors, in both the legitimate and R1 bands", () => {
    for (const p of [0.3, 0.6]) {
      const f = baseFacts();
      f.txn = { type: "Transaction", id: "9900004" };
      f.rings = [];
      f.connected_card_ids = [];
      f.verification_unanswered = true;
      const recs = recommendActions(f, assess(p, 1 - p), [], p < 0.4 ? "legitimate" : "uncertain");
      const decline = recs.actions.find((a) => a.action === "DECLINE_TRANSACTION");
      expect(decline?.route).toBe("L1");
      expect(decline?.reason).toMatch(/^R4: .*flagged authorization \(txn 9900004\)/);
      expect(recs.actions.map((a) => a.action)).toContain("MONITOR_CARD");
      expect(recs.actions.map((a) => a.action)).not.toContain("BLOCK_CARD");
      expect(recs.actions.find((a) => a.action === "MONITOR_CARD")!.reason).not.toContain("no pending authorization");
    }
  });

  it("block and case reasons cite the rule that applies (README §7), not R2/R6 by default", () => {
    // Model alert, no dispute, no shared origin: no R2, no R6.
    const alert = baseFacts();
    alert.rings = [];
    alert.connected_card_ids = [];
    const recs = recommendActions(alert, assess(0.84, 0.16, 0.8, "out_of_region_use"), [], "fraud");
    const block = recs.actions.find((a) => a.action === "BLOCK_CARD")!;
    const kase = recs.actions.find((a) => a.action === "CREATE_CASE")!;
    expect(block.reason).toMatch(/fraud probability 0\.84 is at or above 0\.70, so R1's verify-first step does not apply/);
    expect(block.reason).not.toMatch(/R2|R6/);
    expect(kase.reason).toMatch(/^§3a: fraud probability 0\.84 reached 0\.30/);
    expect(kase.reason).not.toContain("R6");

    // Dispute: R2 on both.
    const dispute = baseFacts();
    dispute.rings = [];
    dispute.connected_card_ids = [];
    dispute.customer_denied = true;
    const d = recommendActions(dispute, assess(0.84, 0.16, 0.8, "out_of_region_use"), [], "fraud");
    expect(d.actions.find((a) => a.action === "BLOCK_CARD")!.reason).toMatch(/^R2: the cardholder disputed/);
    expect(d.actions.find((a) => a.action === "CREATE_CASE")!.reason).toMatch(/^R2 and §3a/);
  });

  it("§3a: a confirmed legitimate close at fraud probability 0.30-0.50 still opens a case", () => {
    const f = baseFacts();
    f.customer_confirmed = true;
    // Pattern resolves to "none" with 0.40 fraud mass when the only fraud
    // hypothesis is an `undocumented` one the graph does not support.
    const lean = finalizeAssessment(
      {
        hypotheses: [
          { fraud_type: "legitimate", probability: 0.6, supporting: [], contradicting: [] },
          { fraud_type: "undocumented", probability: 0.4, supporting: [], contradicting: [] },
        ],
        risk_level: "LOW",
        risk_score: 0.4,
        confidence: 0.8,
        legit_hypothesis_probability: 0.6,
      },
      [],
      SUFFICIENT,
    );
    const actions = recommendActions(f, lean, [], "legitimate").actions.map((a) => a.action);
    expect(actions).toContain("CREATE_CASE");
    expect(actions).toContain("CLOSE_NO_FRAUD");
    expect(actions).not.toContain("BLOCK_CARD");
  });

  // R10 ("never BLOCK_ALL_CARDS unless at least two of the customer's CARDS
  // show confirmed fraud") was counting prior *cases*. find_prior_cases is
  // scoped to one card, so three historical frauds on that single card read
  // as three cards and every fraud verdict recommended a full card block.
  it("R10: several prior frauds on the one card do not justify BLOCK_ALL_CARDS", () => {
    const f = baseFacts();
    f.prior_cases = [
      { case_id: "CC-2400", outcome: "confirmed_fraud", pattern: "account_takeover" },
      { case_id: "CC-2717", outcome: "confirmed_fraud", pattern: "account_takeover" },
      { case_id: "CC-2857", outcome: "confirmed_fraud", pattern: "account_takeover" },
    ];
    const recs = recommendActions(f, assess(0.9, 0.05, 0.9), [], "fraud");
    expect(recs.actions.map((a) => a.action)).not.toContain("BLOCK_ALL_CARDS");
  });

  // The old fallback read `legit_hypothesis_probability` AS the fraud
  // probability whenever no fraud hypothesis survived, inverting it: a case
  // the model was certain was legitimate filed fraud_probability 1.0 and was
  // read as fraud by every band downstream, while recommendActions saw 0 and
  // recommended ALLOW_TRANSACTION on the same case (HHG-006).
  it("a legitimate-only assessment yields a LOW fraud probability, not a high one", () => {
    const legitOnly = finalizeAssessment(
      {
        hypotheses: [{ fraud_type: "legitimate", probability: 1, supporting: [], contradicting: [] }],
        risk_level: "LOW",
        risk_score: 0.2,
        confidence: 0.8,
        legit_hypothesis_probability: 1,
      },
      [],
      SUFFICIENT,
    );
    expect(fraudProbability(legitOnly)).toBeLessThanOrEqual(0.05);
  });

  it("summarizeChange describes the delta between initial and final action sets", () => {
    const f = baseFacts();
    const initial = recommendActions(f, assess(0.55, 0.4, 0.6), [], "uncertain").actions;
    f.customer_denied = true;
    const current = recommendActions(f, assess(0.55, 0.4, 0.6, "card_testing"), [], "fraud").actions;
    const text = summarizeChange(initial, current, assess(0.55, 0.4, 0.6, "card_testing"), f);
    expect(text.length).toBeGreaterThan(0);
  });

  it("summarizeChange: nothing requested and nothing changed is \"nothing\" (README line 356)", () => {
    const f = baseFacts();
    const a = recommendActions(f, assess(0.55, 0.4, 0.6), [], "uncertain").actions;
    expect(summarizeChange(a, a, assess(0.55, 0.4, 0.6), f)).toBe("nothing");
  });

  it("summarizeChange: a request with no reply says so instead of \"nothing\"", () => {
    const f = baseFacts();
    const a = recommendActions(f, assess(0.55, 0.4, 0.6), [], "uncertain").actions;
    const text = summarizeChange(a, a, assess(0.55, 0.4, 0.6), f, [{ type: "customer_validation" }]);
    expect(text).toContain("customer validation");
    expect(text).toContain("no reply was received");
    expect(text).not.toMatch(/confirm|denied|denies/i);
  });

  it("summarizeChange names the actions added and dropped", () => {
    const f = baseFacts();
    const initial = recommendActions(f, assess(0.55, 0.4, 0.6), [], "uncertain").actions;
    const current = recommendActions(f, assess(0.9, 0.05, 0.9), [], "fraud").actions;
    const text = summarizeChange(initial, current, assess(0.9, 0.05, 0.9), f);
    expect(text).toContain("added");
    expect(text).toContain("BLOCK_CARD");
  });

  // R8's second trigger ("...or the evidence conflicts") was never
  // implemented — only the exposure > $500 half was — so a split evidence
  // record could close as uncertain with no analyst ever seeing it.
  it("R8: an uncertain case with conflicting evidence escalates to an analyst even under $500", () => {
    const f = baseFacts();
    f.exposure_usd = 100.09;
    const conflicting = [
      ev("ev_c1", "txn_behavior", ["card_testing"], [], 0.6),
      ev("ev_c2", "txn_behavior", [], ["card_testing"], 0.6),
    ];
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), conflicting, "uncertain");
    const escalate = recs.actions.find((a) => a.action === "ESCALATE_TO_ANALYST");
    expect(escalate).toBeDefined();
    expect(escalate!.reason).toContain("R8");
    expect(escalate!.reason).toContain("card_testing");
  });

  // R8 is scoped to an uncertain *verdict*, but was keyed off the probability
  // band, so a case the cardholder had confirmed still escalated. HHG-006
  // shipped "R8: uncertain with exposure $1906.07" while declaring itself
  // legitimate with $0 exposure.
  it("R8: a legitimate verdict does not escalate, whatever the exposure", () => {
    const f = baseFacts();
    f.exposure_usd = 1906.07;
    const conflicting = [
      ev("ev_c1", "txn_behavior", ["card_testing"], []),
      ev("ev_c2", "txn_behavior", [], ["card_testing"]),
    ];
    const recs = recommendActions(f, assess(0.45, 0.4, 0.6), conflicting, "legitimate");
    expect(recs.actions.map((a) => a.action)).not.toContain("ESCALATE_TO_ANALYST");
  });

  // Ordinary differential evidence -- a pattern the case is *not* being called
  // on is both supported and ruled out -- escalated every uncertain case,
  // including all three cleared cases in the 20-case backtest.
  it("R8: disagreement about a pattern other than the leading one does not escalate", () => {
    const f = baseFacts();
    f.exposure_usd = 100.09;
    const differential = [
      ev("ev_d1", "txn_behavior", ["card_testing"], [], 0.8),
      ev("ev_d2", "txn_behavior", ["out_of_region_use"], [], 0.6),
      ev("ev_d3", "txn_behavior", [], ["out_of_region_use"], 0.6),
    ];
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), differential, "uncertain");
    expect(recs.actions.map((a) => a.action)).not.toContain("ESCALATE_TO_ANALYST");
    expect(recs.actions.map((a) => a.action)).toContain("VERIFY_WITH_CUSTOMER");
  });

  it("R8: a conflict carried only by sub-material evidence does not escalate", () => {
    const f = baseFacts();
    f.exposure_usd = 100.09;
    const weak = [
      ev("ev_w1", "txn_behavior", ["card_testing"], [], 0.3),
      ev("ev_w2", "txn_behavior", [], ["card_testing"], 0.3),
    ];
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), weak, "uncertain");
    expect(recs.actions.map((a) => a.action)).not.toContain("ESCALATE_TO_ANALYST");
  });

  it("R8: material support for both fraud and legitimate escalates", () => {
    const f = baseFacts();
    f.exposure_usd = 100.09;
    const split = [
      ev("ev_s1", "txn_behavior", ["card_testing"], [], 0.7),
      ev("ev_s2", "device_identity", ["legitimate"], [], 0.6),
    ];
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), split, "uncertain");
    const escalate = recs.actions.find((a) => a.action === "ESCALATE_TO_ANALYST");
    expect(escalate?.reason).toContain("fraud vs legitimate");
  });

  it("R8: an uncertain case with a consistent record under $500 does not escalate", () => {
    const f = baseFacts();
    f.exposure_usd = 100.09;
    const agreeing = [
      ev("ev_a1", "txn_behavior", ["card_testing"], []),
      ev("ev_a2", "device_identity", ["card_testing"], []),
    ];
    const recs = recommendActions(f, assess(0.55, 0.4, 0.6), agreeing, "uncertain");
    expect(recs.actions.map((a) => a.action)).not.toContain("ESCALATE_TO_ANALYST");
  });
})

function ev(
  id: string,
  category: EvidenceItem["category"],
  supports: string[],
  contradicts: string[],
  weight_hint = 0.5,
): EvidenceItem {
  return {
    id,
    category,
    summary: `${id} fixture`,
    entities: [],
    source_tool: "test",
    weight_hint,
    supports,
    contradicts,
    ts: AS_OF,
  };
}
