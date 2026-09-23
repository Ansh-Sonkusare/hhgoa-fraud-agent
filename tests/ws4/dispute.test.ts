import { describe, it, expect } from "vitest";
import {
  checkRecurringCharge,
  createFacts,
  createGatherRuntime,
  runStandardGather,
} from "../../agent/src/investigation.js";
import { recommendActions } from "../../agent/src/recommend.js";
import { finalizeAssessment } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import type { EvidenceItem, ToolCatalog } from "../../contracts/src/index.js";

const AS_OF = "2016-12-10T15:01:21Z";
const DAY = 86_400_000;
const at = (daysBefore: number) => new Date(Date.parse(AS_OF) - daysBefore * DAY).toISOString();

const row = (txn_id: string, daysBefore: number, amount_usd = 9.99, product_cd = "S") => ({
  txn_id, ts: at(daysBefore), amount_usd, product_cd, channel: "online", risk_score: 0.2,
});

/** Every tool fails unless a handler is given, so each test states what it relies on. */
function fakeCatalog(handlers: Partial<Record<keyof ToolCatalog, (...a: unknown[]) => unknown>>): ToolCatalog {
  return new Proxy({} as ToolCatalog, {
    get: (_t, name: string) => async (...args: unknown[]) => {
      const h = handlers[name as keyof ToolCatalog];
      return h ? { ok: true, data: h(...args) } : { ok: false, error: { code: "unavailable", message: name } };
    },
  });
}

const dispute = { kind: "customer_report" as const, customer_id: "C08623", txn_ids: ["3530164"], text: "I never made this $9.99 purchase." };

function assessment(top: number, legit: number, topType: string | null): ReturnType<typeof finalizeAssessment> {
  const hyps = [{ fraud_type: "legitimate", probability: legit, supporting: [], contradicting: [] }];
  if (topType) hyps.unshift({ fraud_type: topType, probability: top, supporting: [], contradicting: [] });
  const proposal: AssessmentProposal = { hypotheses: hyps, risk_level: "LOW", risk_score: 0.3, confidence: 0.6, legit_hypothesis_probability: legit };
  return finalizeAssessment(proposal, [], { sufficient: false, missing: [], stop_reason: null });
}

describe("checkRecurringCharge (R7)", () => {
  it("finds two earlier charges a month apart as recurring", () => {
    const rows = [row("3530164", 0), row("a", 30), row("b", 61), row("c", 12, 9.99, "W")];
    expect(checkRecurringCharge(rows, "3530164", false)).toEqual({ status: "recurring", months: 2, matches: 2 });
  });

  it("does not count irregular repeats of a common price as a subscription", () => {
    // HHG-018's shape: the same amount again and again, days apart, never monthly.
    const rows = [row("3530164", 0), row("a", 5), row("b", 24), row("c", 33), row("d", 50)];
    expect(checkRecurringCharge(rows, "3530164", false)).toEqual({ status: "not_recurring", matches: 4 });
  });

  it("needs two monthly steps, not one", () => {
    const rows = [row("3530164", 0), row("a", 30)];
    expect(checkRecurringCharge(rows, "3530164", false).status).toBe("not_recurring");
  });

  it("will not rule R7 out from a capped history that never reached back two months", () => {
    const rows = [row("3530164", 0), row("a", 3), row("b", 9)];
    const r = checkRecurringCharge(rows, "3530164", true);
    expect(r.status).toBe("unchecked");
  });

  it("reports the check as unrun when the disputed charge is not in the window", () => {
    expect(checkRecurringCharge([row("x", 4)], "3530164", false).status).toBe("unchecked");
  });

  it("says the history was truncated, not that the charge is absent, when the row cap hid it", () => {
    const r = checkRecurringCharge([row("x", 4)], "3530164", true);
    expect(r.status).toBe("unchecked");
    expect(r.status === "unchecked" && r.reason).toContain("do not reach back to the disputed transaction");
    expect(r.status === "unchecked" && r.reason).not.toContain("is not in the card's");
  });
});

describe("a disputed charge older than the investigation window (CC-2394)", () => {
  // The disputed charge is 20 days before the case opened; the card is busy,
  // so a 120-day read as of the case only returns rows from the last 18 days.
  const DISPUTED_DAYS = 20;
  const card = { type: "Card", id: "C08962-K2" };
  const txn = { type: "Transaction", id: "3128855" };
  function runWith(historyCalls: Array<{ window: unknown; asOf: unknown }>) {
    const facts = createFacts("CC-2394", AS_OF, { ...dispute, txn_ids: ["3128855"] });
    const catalog = fakeCatalog({
      resolve_trigger: () => ({ txn, card, customer: { type: "Customer", id: "C08962" }, identity: null }),
      get_entity_profile: () => ({ attributes: { entity_id: "3128855", ts: at(DISPUTED_DAYS).slice(0, 19).replace("T", " "), amount_usd: 42.47 } }),
      get_transaction_history: (_c, w, asOf) => {
        historyCalls.push({ window: w, asOf });
        const hours = (w as { hours?: number }).hours;
        const anchoredAtDispute = String(asOf).startsWith(at(DISPUTED_DAYS).slice(0, 10));
        if (anchoredAtDispute) return { rows: [row("3128855", DISPUTED_DAYS, 42.47), row("p", DISPUTED_DAYS + 3)] };
        if (hours !== undefined && hours >= DISPUTED_DAYS * 24) return { rows: [row("3128855", DISPUTED_DAYS, 42.47), row("n", 1)] };
        return { rows: [row("n", 1)] };
      },
    });
    return { facts, catalog };
  }

  it("widens the window back to the disputed charge", async () => {
    const calls: Array<{ window: unknown; asOf: unknown }> = [];
    const { facts, catalog } = runWith(calls);
    await runStandardGather(createGatherRuntime({ catalog, facts, asOf: AS_OF }));
    expect(facts.txn_rows.some((r) => r.txn_id === "3128855")).toBe(true);
    expect(facts.affected_txn_ids).toContain("3128855");
    const widened = calls.find((c) => ((c.window as { hours?: number }).hours ?? 0) > 168);
    expect(widened).toBeDefined();
    expect((widened!.window as { hours: number }).hours).toBeGreaterThanOrEqual(DISPUTED_DAYS * 24);
  });

  it("anchors R7's lookback on the disputed charge, so R7 is actually checked", async () => {
    const calls: Array<{ window: unknown; asOf: unknown }> = [];
    const { facts, catalog } = runWith(calls);
    const seen: EvidenceItem[] = [];
    const g = { ...createGatherRuntime({ catalog, facts, asOf: AS_OF }), onEvidence: async (e: EvidenceItem) => { seen.push(e); } };
    await runStandardGather(g);
    const r7 = calls.find((c) => (c.window as { days?: number }).days === 120)!;
    expect(String(r7.asOf).startsWith(at(DISPUTED_DAYS).slice(0, 10))).toBe(true);
    expect(seen.some((e) => e.summary.startsWith("R7 checked and does not apply"))).toBe(true);
  });
});

describe("customer_report trigger", () => {
  it("is recorded as the cardholder's denial even when the graph is unavailable", async () => {
    const facts = createFacts("HHG-003", AS_OF, dispute);
    const seen: EvidenceItem[] = [];
    const g = { ...createGatherRuntime({ catalog: fakeCatalog({}), facts, asOf: AS_OF }), onEvidence: async (e: EvidenceItem) => { seen.push(e); } };
    await runStandardGather(g);
    expect(facts.customer_denied).toBe(true);
    expect(facts.dispute_recurring).toBe(false);
    const report = seen.find((e) => e.source_tool === "customer_report")!;
    expect(report.category).toBe("customer_response");
    expect(report.supports).toEqual(["fraud"]);
    expect(report.summary).toContain("I never made this $9.99 purchase.");
    expect(seen.some((e) => e.summary.startsWith("R7 could not be checked"))).toBe(true);
  });

  it("does not set a denial for a risk-score alert", async () => {
    const facts = createFacts("HHG-001", AS_OF, { kind: "risk_score", txn_id: "3514030", risk_score: 0.61 });
    const g = createGatherRuntime({ catalog: fakeCatalog({}), facts, asOf: AS_OF });
    await runStandardGather(g);
    expect(facts.customer_denied).toBe(false);
  });

  it("switches to R7 instead of R2 when the disputed charge is the card's monthly charge", async () => {
    const facts = createFacts("HHG-R7", AS_OF, dispute);
    const card = { type: "Card", id: "C08623-K2" };
    const txn = { type: "Transaction", id: "3530164" };
    const catalog = fakeCatalog({
      resolve_trigger: () => ({ txn, card, customer: { type: "Customer", id: "C08623" }, identity: null }),
      get_transaction_history: (_c, w) =>
        (w as { days?: number }).days
          ? { rows: [row("3530164", 0), row("a", 30), row("b", 60)] }
          : { rows: [row("3530164", 0)] },
    });
    await runStandardGather(createGatherRuntime({ catalog, facts, asOf: AS_OF }));
    expect(facts.dispute_recurring).toBe(true);
    expect(facts.customer_denied).toBe(false);
  });
});

describe("recommendActions for disputes", () => {
  it("R7: verifies and warns, never blocks", () => {
    const f = createFacts("HHG-R7", AS_OF, dispute);
    f.dispute_recurring = true;
    const actions = recommendActions(f, assessment(0, 0.8, null), [], "legitimate").actions.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["CREATE_CASE", "VERIFY_WITH_CUSTOMER", "WARN_CUSTOMER"]));
    expect(actions).not.toContain("BLOCK_CARD");
  });

  it("R2: a denial with no named pattern still blocks and opens a case instead of closing", () => {
    const f = createFacts("HHG-003", AS_OF, dispute);
    f.customer_denied = true;
    const actions = recommendActions(f, assessment(0, 0.7, null), [], "uncertain").actions.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["BLOCK_CARD", "CREATE_CASE"]));
    expect(actions).not.toContain("ALLOW_TRANSACTION");
    expect(actions).not.toContain("CLOSE_NO_FRAUD");
  });
});
