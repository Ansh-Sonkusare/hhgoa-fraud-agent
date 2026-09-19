import { describe, expect, it } from "vitest";
import { loadCasePack, loadIdIndex, loadClosedCases, indexStats } from "../../eval/src/dataset.js";
import { repoRoot } from "../../eval/src/env.js";
import path from "node:path";

describe("case pack", () => {
  it("parses exactly 20 cases and sorts them chronologically by opened_at", () => {
    const cases = loadCasePack(path.join(repoRoot(), "data"));
    expect(cases.length).toBe(20);
    const opened = cases.map((c) => c.opened_at);
    const sorted = [...opened].sort();
    expect(opened).toEqual(sorted);
    // HHG-017 opens 2016-11-12, HHG-015 2016-11-17 → both before HHG-001 (Dec).
    const ids = cases.map((c) => c.case_id);
    expect(ids.indexOf("HHG-017")).toBe(0);
    expect(ids.indexOf("HHG-001")).toBeGreaterThanOrEqual(2);
    for (const c of cases) expect(c.case_id).toMatch(/^HHG-0\d{2}$/);
    for (const c of cases) expect(c.trigger_text.length).toBeGreaterThan(0);
  });

  it("fills risk_score only for risk_score triggers", () => {
    const cases = loadCasePack(path.join(repoRoot(), "data"));
    for (const c of cases) {
      if (c.trigger_type === "risk_score") expect(c.risk_score).not.toBeNull();
      else expect(c.risk_score).toBeNull();
    }
  });
});

describe("dataset id index", () => {
  it("resolves the dataset namespaces used by the validator", async () => {
    const index = await loadIdIndex(path.join(repoRoot(), "data"));
    expect(index.txnIds.size).toBeGreaterThan(500_000);
    expect(index.closedCaseIds.size).toBe(5565);
    expect(index.cardIds.size).toBeGreaterThan(1000);
    expect(index.customerIds.size).toBeGreaterThan(1000);
    const stats = indexStats(index);
    expect(stats.transactions).toBe(index.txnIds.size);
  });
});

describe("closed cases", () => {
  it("reads the labeled July–Oct history with both outcomes", async () => {
    const closed = loadClosedCases(path.join(repoRoot(), "data"));
    expect(closed.length).toBe(5565);
    const fraud = closed.filter((c) => c.outcome === "confirmed_fraud").length;
    expect(fraud).toBeGreaterThan(4000);
    expect(closed.some((c) => c.outcome === "cleared")).toBe(true);
    expect(closed.some((c) => c.first_fraud_txn_id === "")).toBe(true);
    // Sampled smoke: a confirmed case points at transactions that resolve.
    const first = closed.find((c) => c.first_fraud_txn_id !== "")!;
    const index = await loadIdIndex(path.join(repoRoot(), "data"));
    expect(index.txnIds.has(first.first_fraud_txn_id)).toBe(true);
  });
});