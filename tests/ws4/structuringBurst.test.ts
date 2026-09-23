import { describe, it, expect } from "vitest";
import { recommendActions } from "../../agent/src/recommend.js";
import { createFacts, type InvestigationFacts } from "../../agent/src/investigation.js";
import { finalizeAssessment, resolvePatternLabel } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import {
  buildEvidenceForTool,
  createEvidenceIdGen,
  describeStructuringBurst,
  detectorWeight,
} from "../../agent/src/evidenceBuilder.js";

// The single-card amount-structuring burst detect_patterns reports as
// `undocumented`: it names the pattern, describes it from the case's own rows,
// and takes the ordinary R2/§3a path -- R9's triple is for abuse across customers.

const AS_OF = "2016-10-02T12:00:00Z";
const BURST = ["7700001", "7700002", "7700003", "7700004"];
const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };

function facts(): InvestigationFacts {
  const f = createFacts("HHG-ST-1", AS_OF, { kind: "customer_report", customer_id: "C12267", txn_ids: ["7700001"], text: "four charges I did not make" });
  f.customer_denied = true;
  f.primary_card = { type: "Card", id: "C12267-K1" };
  f.txn_rows = [
    { txn_id: "7700001", ts: "2016-10-02T11:00:00Z", amount_usd: 491.36, product_cd: "W", channel: "online", risk_score: 0.3 },
    { txn_id: "7700002", ts: "2016-10-02T11:09:00Z", amount_usd: 476.88, product_cd: "W", channel: "online", risk_score: 0.3 },
    { txn_id: "7700003", ts: "2016-10-02T11:18:00Z", amount_usd: 468.58, product_cd: "W", channel: "online", risk_score: 0.3 },
    { txn_id: "7700004", ts: "2016-10-02T11:27:00Z", amount_usd: 468.39, product_cd: "W", channel: "online", risk_score: 0.3 },
  ];
  f.affected_txn_ids = [...BURST];
  f.exposure_usd = 1905.21;
  f.patterns = [{ pattern_id: "undocumented", score: 0.85, evidence: [...BURST] }];
  return f;
}

function assessment(top = 0.85) {
  const proposal: AssessmentProposal = {
    hypotheses: [
      { fraud_type: "card_not_present_new_device", probability: top, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: 1 - top, supporting: [], contradicting: [] },
    ],
    risk_level: "HIGH",
    risk_score: top,
    confidence: 0.8,
    legit_hypothesis_probability: 1 - top,
  };
  return finalizeAssessment(proposal, [], SUFFICIENT);
}

describe("amount-structuring burst", () => {
  it("files an evidence item that supports undocumented at its calibrated weight", () => {
    const items = buildEvidenceForTool(
      "detect_patterns",
      { patterns: [{ pattern_id: "undocumented", score: 0.85, evidence: BURST }] },
      createEvidenceIdGen(),
      AS_OF,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.supports).toEqual(["undocumented"]);
    expect(items[0]!.weight_hint).toBe(detectorWeight("undocumented", 0.85));
    expect(items[0]!.summary).toContain("Amount-structuring burst: 4 online charges within one hour");
  });

  it("describes the burst from the case's own rows", () => {
    const f = facts();
    const text = describeStructuringBurst(BURST, f.txn_rows, "C12267-K1");
    expect(text).toContain("4 online charges on card C12267-K1 within 27 minutes");
    expect(text).toContain("$491.36, $476.88, $468.58, $468.39");
  });

  it("falls back to what the rule guarantees when a detector txn is not in the rows", () => {
    const text = describeStructuringBurst([...BURST, "7799999"], facts().txn_rows);
    expect(text).toContain("5 online charges on the card within one hour, each between $400 and $500");
  });

  it("the label resolves to undocumented when the graph reports it", () => {
    expect(resolvePatternLabel(assessment(), true)).toBe("undocumented");
    expect(resolvePatternLabel(assessment(), false)).toBe("card_not_present_new_device");
  });

  it("takes the R2/§3a path: block, case, report -- no R9 escalation for a single card", () => {
    const recs = recommendActions(facts(), assessment(), [], "fraud");
    const names = recs.actions.map((a) => a.action);
    expect(names).toContain("BLOCK_CARD");
    expect(names).toContain("CREATE_CASE");
    expect(names).toContain("FILE_REPORT");
    expect(names).not.toContain("ESCALATE_TO_ANALYST");
    const report = recs.actions.find((a) => a.action === "FILE_REPORT")!;
    expect(report.reason).toContain("the pattern is undocumented (§3a)");
  });
});
