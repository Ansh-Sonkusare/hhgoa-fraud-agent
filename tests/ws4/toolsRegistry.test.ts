import { describe, it, expect } from "vitest";
import { ToolRegistry, ToolBudgetExceededError } from "../../agent/src/toolsRegistry.js";
import { EventLog } from "../../agent/src/events.js";
import { createMcpClient } from "../../agent/src/mcpClient.js";
import { fakes } from "../../contracts/src/fakes.js";
import { createPolicyAdapters } from "../../agent/src/agentFactory.js";
import type { Assessment } from "../../contracts/src/assessment.js";

const AS_OF = "2016-11-12T00:35:00Z";

const ASSESSMENT: Assessment = {
  hypotheses: [
    { fraud_type: "card_testing", probability: 0.8, supporting: [], contradicting: [] },
    { fraud_type: "legitimate", probability: 0.2, supporting: [], contradicting: [] },
  ],
  risk_level: "HIGH",
  risk_score: 0.8,
  confidence: 0.8,
  sufficiency: { sufficient: true, missing: [], stop_reason: "sufficient_evidence" },
  legit_hypothesis_probability: 0.2,
};

function makeRegistry(maxToolCalls = 25) {
  const events = new EventLog("HHG-TR-1");
  const registry = new ToolRegistry({
    caseId: "HHG-TR-1",
    mcp: createMcpClient("fake"),
    providers: fakes,
    policies: createPolicyAdapters(),
    events,
    asOf: AS_OF,
    maxToolCalls,
  });
  return { registry, events };
}

describe("ToolRegistry budget semantics", () => {
  it("resolve_trigger is instrumented but never charged (fixture reconciliation)", async () => {
    const { registry, events } = makeRegistry();
    await registry.run("resolve_trigger", { trigger: { kind: "risk_score", risk_score: 0.78 } });
    expect(registry.budgetUsed).toBe(0);
    expect(events.count("tool_call")).toBe(1);
    expect(events.count("tool_result")).toBe(1);
  });

  it("graph tools inject as_of into the args they emit", async () => {
    const { registry, events } = makeRegistry();
    await registry.run("get_transaction_history", {
      entity: { type: "Card", id: "C09001-K1" },
      window: { hours: 2 },
    });
    const call = events.list().find((e) => e.type === "tool_call")!;
    expect(call.payload["args"]).toMatchObject({
      entity: { type: "Card", id: "C09001-K1" },
      window: { hours: 2 },
      as_of: AS_OF,
    });
  });

  it("case_bookkeeping accessors charge asymmetrically per the fixture count", async () => {
    const { registry, events } = makeRegistry();
    await registry.caseUpdateAssessment(ASSESSMENT);
    await registry.caseRecordAction({ action: "BLOCK_CARD", route: "L1", reason: "verified" }, "EXECUTED");
    await registry.caseSetStatus("escalated");
    await registry.caseClose();
    expect(registry.budgetUsed).toBe(2); // assessment + record; status/close free
    expect(events.count("tool_call")).toBe(0); // silent accessors emit nothing
  });

  it("throwing providers surface as ok:false envelopes, not thrown exceptions", async () => {
    const { registry } = makeRegistry();
    await registry.run("get_wide_features", { txn_ids: ["x"] }); // no-op, local list below
    const { registry: r2, events: e2 } = (() => {
      const events = new EventLog("HHG-TR-2");
      const registry = new ToolRegistry({
        caseId: "HHG-TR-2",
        mcp: createMcpClient("fake"),
        providers: { ...fakes, get_wide_features: async () => {
          throw new Error("duckdb read failure");
        } },
        policies: createPolicyAdapters(),
        events,
        asOf: AS_OF,
        maxToolCalls: 25,
      });
      return { registry, events };
    })();
    void registry;
    void e2;
    const res = await r2.run("get_wide_features", { txn_ids: ["1"] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("duckdb read failure");
  });

  it("beginTool throws ToolBudgetExceededError past max and never emits tool_call on exhaustion", async () => {
    const { registry, events } = makeRegistry(1);
    // One charged call consumes the entire budget.
    await registry.run("get_transaction_history", {
      entity: { type: "Card", id: "C09001-K1" },
      window: { hours: 2 },
    });
    await expect(
      registry.run("find_shared_entity_rings", { entity: { type: "Card", id: "C09001-K1" } }),
    ).rejects.toBeInstanceOf(ToolBudgetExceededError);
    const calls = events.list().filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(1);
    // In-budget silent accessors never throw even when exhausted.
    await registry.caseSetStatus("closed_fraud");
    expect(registry.budgetExhausted).toBe(true);
  });

  it("run always pairs tool_call with tool_result", async () => {
    const { registry, events } = makeRegistry();
    await registry.run("find_prior_cases", { entity: { type: "Card", id: "C09001-K1" } });
    const types = events.list().map((e) => e.type);
    expect(types).toEqual(["tool_call", "tool_result"]);
  });
})