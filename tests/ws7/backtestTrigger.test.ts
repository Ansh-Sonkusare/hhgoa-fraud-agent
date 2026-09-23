import { describe, it, expect } from "vitest";
import { targetFromClosedCase } from "../../eval/src/backtest.js";
import { loadClosedCases, type ClosedCase } from "../../eval/src/dataset.js";

const base: ClosedCase = {
  case_id: "CC-0003", customer_id: "C00001", card_id: "C00001-K1", opened_at: "2016-07-03 10:00:00",
  closed_at: "2016-07-05 10:00:00", outcome: "cleared", pattern: "", first_fraud_txn_id: "", txn_ids: ["3000500"],
  n_txns: 1, exposure_usd: 0, connected_card_ids: [], report_filed: false, analyst_notes: "",
};

describe("targetFromClosedCase", () => {
  it("replays a model alert with the score the model actually gave", () => {
    const c = { ...base, analyst_notes: "Case CC-0003: model scored a $1,442.92 transaction at 0.91. Cardholder confirmed travel to the billing region in question. Alert cleared." };
    expect(targetFromClosedCase(c, 0).trigger).toEqual({ kind: "risk_score", txn_id: "3000500", card_id: "C00001-K1", risk_score: 0.91 });
  });

  it("replays a dispute as the cardholder's report, without the note's outcome", () => {
    const c = { ...base, outcome: "confirmed_fraud" as const, first_fraud_txn_id: "3000120", txn_ids: ["3000120", "3000121"],
      analyst_notes: "Case CC-0001: cardholder C00001 reported unrecognized activity on card C00001-K1. 2 transaction(s) between 2016-07-02 and 2016-07-02 totaling $155.43 were confirmed as fraud." };
    const t = targetFromClosedCase(c, 0).trigger;
    expect(t).toMatchObject({ kind: "customer_report", customer_id: "C00001", txn_ids: ["3000120"] });
    if (t.kind !== "customer_report") throw new Error("unreachable");
    expect(t.text).not.toMatch(/confirmed|fraud|cleared/i);
  });

  it("refuses to guess when the note does not say how the case opened", () => {
    expect(() => targetFromClosedCase({ ...base, analyst_notes: "Case CC-9: something else." }, 0)).toThrow(/how the case opened/);
  });

  it("classifies every closed case in the dataset", () => {
    let cases: ClosedCase[];
    try { cases = loadClosedCases(); } catch { return; } // data/ is gitignored
    const kinds = cases.map((c) => targetFromClosedCase(c, 0).trigger.kind);
    expect(kinds.filter((k) => k === "customer_report").length).toBe(4665);
    expect(kinds.filter((k) => k === "risk_score").length).toBe(900);
  });
});
