import { describe, it, expect } from "vitest";
import {
  createFacts,
  createGatherRuntime,
  runStandardGather,
  COMPACT_GATHER_STEPS,
} from "../../agent/src/investigation.js";
import { fakes } from "../../contracts/src/fakes.js";
import type { ResolveTriggerData, TransactionHistoryData } from "../../contracts/src/tools.js";
import type { ToolResult } from "../../contracts/src/toolEnvelope.js";

const AS_OF = "2016-11-12T00:35:00Z";

describe("runStandardGather", () => {
  it("resolves the trigger and reaches three independent evidence categories", async () => {
    const facts = createFacts("HHG-INV-1", AS_OF, {
      kind: "risk_score",
      txn_id: "9900004",
      card_id: "C09001-K1",
      risk_score: 0.78,
    });
    const collected: unknown[] = [];
    const g = createGatherRuntime({ catalog: fakes, asOf: AS_OF, facts });
    g.onEvidence = async (item) => {
      collected.push(item);
    };
    await runStandardGather(g);

    // Compact sweep only (the recorded runs never walked the fuller plans).
    expect(COMPACT_GATHER_STEPS).toEqual([
      "resolve_trigger",
      "get_transaction_history",
      "find_shared_entity_rings",
      "find_prior_cases",
    ]);

    expect(facts.primary_card).toEqual({ type: "Card", id: "C09001-K1" });
    expect(facts.customer).toEqual({ type: "Customer", id: "C09001" });
    expect(facts.txn).toEqual({ type: "Transaction", id: "9900004" });

    // Affected-rule (risk≥0.3, amount≥$100, or online micro debit) on the
    // example's two-hour history ⇒ the fixture's 4 rows and $264.72 exposure.
    expect(facts.affected_txn_ids).toEqual(["9900001", "9900002", "9900003", "9900004"]);
    expect(facts.exposure_usd).toBeCloseTo(264.72, 2);

    // Shared device ring D000731 links the two example cards.
    expect(facts.rings).toHaveLength(1);
    expect(facts.rings[0]!.shared_id).toBe("D000731");
    expect(facts.rings[0]!.card_ids).toContain("C09002-K1");
    expect(facts.connected_card_ids).toEqual(["C09002-K1"]);
    expect(facts.device_profiles).toEqual(["D000731"]);

    expect(facts.prior_cases).toHaveLength(2);
    expect(facts.prior_cases.map((c) => c.pattern)).toContain("card_testing");

    const categories = new Set(collected.map((it) => (it as { category: string }).category));
    expect(categories.has("txn_behavior")).toBe(true);
    expect(categories.has("device_identity")).toBe(true);
    expect(categories.has("prior_cases")).toBe(true);
  });

  it("runs the baseline-deviation step only when exactly one transaction is affected", async () => {
    const facts = createFacts("HHG-INV-2", AS_OF, {
      kind: "risk_score",
      txn_id: "9900004",
      card_id: "C09001-K1",
      risk_score: 0.78,
    });
    // Custom server returns exactly one affected transaction ⇒ baseline runs.
    const g = createGatherRuntime({
      catalog: {
        ...fakes,
        resolve_trigger: async (): Promise<ToolResult<ResolveTriggerData>> => ({
          ok: true as const,
          tool: "resolve_trigger",
          as_of: AS_OF,
          via: "mcp" as const,
          data: {
            txn: { type: "Transaction" as const, id: "9900004" },
            card: { type: "Card" as const, id: "C09001-K1" },
            customer: { type: "Customer" as const, id: "C09001" },
          },
          evidence_refs: [],
          truncated: false,
          latency_ms: 0,
          error: null,
        }),
        get_transaction_history: async (): Promise<ToolResult<TransactionHistoryData>> => ({
          ok: true as const,
          tool: "get_transaction_history",
          as_of: AS_OF,
          via: "mcp" as const,
          data: {
            rows: [
              { txn_id: "T1", ts: AS_OF, amount_usd: 259.98, product_cd: "C", channel: "online", risk_score: 0.9 },
            ],
            stats: { count: 1, total_amount_usd: 259.98, window: "2h" },
          },
          evidence_refs: [],
          truncated: false,
          latency_ms: 0,
          error: null,
        }),
      },
      asOf: AS_OF,
      facts,
    });
    const tools: string[] = [];
    g.onEvidence = async (item) => {
      tools.push((item as { source_tool: string }).source_tool);
    };
    await runStandardGather(g);
    expect(facts.affected_txn_ids).toEqual(["T1"]);
    expect(tools).toContain("get_baseline_deviation");
  });

  it("does not emit evidence when the graph tools error out (ok:false)", async () => {
    const facts = createFacts("HHG-INV-3", AS_OF, { kind: "risk_score", risk_score: 0.78 });
    const collected: unknown[] = [];
    const g = createGatherRuntime({
      catalog: {
        ...fakes,
        resolve_trigger: async (): Promise<ToolResult<ResolveTriggerData>> => ({
          ok: false as const,
          tool: "resolve_trigger",
          as_of: AS_OF,
          via: "mcp" as const,
          data: {},
          evidence_refs: [],
          truncated: false,
          latency_ms: 0,
          error: "graph down",
        }),
      },
      asOf: AS_OF,
      facts,
    });
    g.onEvidence = async (item) => {
      collected.push(item);
    };
    await runStandardGather(g);
    expect(collected).toEqual([]);
    expect(facts.primary_card).toBeNull();
  });
})
describe("prior cases exclude the case under investigation", () => {
  it("drops both the bare case id and its GRAPH- write-back form", async () => {
    // find_prior_cases gates on `opened_at <= as_of` inclusively, so a case
    // investigated as_of its own opened_at matches its own record. Backtesting
    // a labelled closed case would otherwise hand the agent the very
    // outcome/pattern it is being scored against.
    const facts = createFacts("CC-0001", AS_OF, {
      kind: "risk_score",
      txn_id: "9900004",
      card_id: "C09001-K1",
      risk_score: 0.78,
    });
    const catalog = {
      ...fakes,
      find_prior_cases: async () => ({
        ok: true as const,
        data: {
          cases: [
            { case_id: "CC-0001", outcome: "confirmed_fraud", pattern: "card_testing" },
            { case_id: "GRAPH-CC-0001", outcome: "confirmed_fraud", pattern: "card_testing" },
            { case_id: "CC-0999", outcome: "cleared", pattern: "" },
          ],
        },
      }),
    };
    const g = createGatherRuntime({ catalog: catalog as unknown as typeof fakes, asOf: AS_OF, facts });
    g.onEvidence = async () => {};
    await runStandardGather(g);

    const ids = facts.prior_cases.map((c) => c.case_id);
    expect(ids).not.toContain("CC-0001");
    expect(ids).not.toContain("GRAPH-CC-0001");
    expect(ids).toContain("CC-0999");
  });
});
