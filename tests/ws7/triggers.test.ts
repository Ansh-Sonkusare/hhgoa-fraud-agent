import { describe, expect, it } from "vitest";
import { buildTrigger } from "../../eval/src/triggers.js";
import { loadCasePack } from "../../eval/src/dataset.js";
import { repoRoot } from "../../eval/src/env.js";
import path from "node:path";

describe("buildTrigger", () => {
  const cases = loadCasePack(path.join(repoRoot(), "data"));

  it("maps risk_score rows to a RiskSignalTrigger", () => {
    const hhg1 = cases.find((c) => c.case_id === "HHG-001")!;
    const t = buildTrigger(hhg1);
    expect(t.kind).toBe("risk_score");
    if (t.kind === "risk_score") {
      expect(t.txn_id).toBe(hhg1.flagged_txn_id);
      expect(t.card_id).toBe(hhg1.card_id);
      expect(t.risk_score).toBeCloseTo(0.61);
    }
  });

  it("maps customer_report rows to a CustomerReportTrigger with the flagged txn", () => {
    const hhg3 = cases.find((c) => c.case_id === "HHG-003")!;
    const t = buildTrigger(hhg3);
    expect(t.kind).toBe("customer_report");
    if (t.kind === "customer_report") {
      expect(t.customer_id).toBe(hhg3.customer_id);
      expect(t.txn_ids).toEqual([hhg3.flagged_txn_id]);
      expect(t.text).toBe(hhg3.trigger_text);
    }
  });

  // Resolves to the flagged TRANSACTION, not the card. AnalystRequestTrigger
  // has no txn field (frozen contract), so the transaction is carried as the
  // entity — resolve_trigger walks txn -> card -> customer either way. Going
  // in on the card left facts.txn unset, so the ±window history sweep had no
  // anchor and affected_txn_ids came back empty on a case we called fraud,
  // which the answer format requires to list the flagged transaction.
  it("maps analyst_request rows to an AnalystRequestTrigger on the flagged transaction", () => {
    const hhg14 = cases.find((c) => c.case_id === "HHG-014")!;
    const t = buildTrigger(hhg14);
    expect(t.kind).toBe("analyst_request");
    if (t.kind === "analyst_request") {
      expect(t.entity).toEqual({ type: "Transaction", id: hhg14.flagged_txn_id });
      expect(t.question).toBe(hhg14.trigger_text);
    }
  });

  it("covers all three kinds across the 20 cases", () => {
    const kinds = new Set(cases.map((c) => buildTrigger(c).kind));
    expect(kinds).toEqual(new Set(["risk_score", "customer_report", "analyst_request"]));
  });
});