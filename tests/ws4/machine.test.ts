import { describe, it, expect } from "vitest";
import { runAgent, createLlmClient } from "../../agent/src/agentFactory.js";
import { FakeMcpClient, type McpClient, type McpGraphToolName } from "../../agent/src/mcpClient.js";
import type { Trigger } from "../../contracts/src/tools.js";
import type { MockScriptEntry } from "../../agent/src/llm.js";

const AS_OF = "2016-11-12T00:35:00Z";
const TRIGGER: Trigger = { kind: "risk_score", risk_score: 0.78 };

async function run(
  overrides: { script?: MockScriptEntry[]; maxToolCalls?: number } = {},
) {
  return runAgent({
    caseId: "HHG-WS4-1",
    asOf: AS_OF,
    trigger: TRIGGER,
    llm: createLlmClient("mock", overrides.script),
    backend: "fake",
    maxToolCalls: overrides.maxToolCalls,
  });
}

const WEAK_SCRIPT = [
  {
    json: {
      hypotheses: [
        { fraud_type: "card_testing", probability: 0.55, supporting: [], contradicting: [] },
        { fraud_type: "legitimate", probability: 0.4, supporting: [], contradicting: [] },
      ],
      risk_level: "MEDIUM",
      risk_score: 0.5,
      confidence: 0.6,
      legit_hypothesis_probability: 0.4,
    },
  },
];

describe("FraudInvestigationMachine end-to-end (contracts/examples data)", () => {
  it("clear-fraud first pass stops sufficient, emits the fixture event order, and assembles answer", async () => {
    const r = await run();

    // Event order (types only) matches the recorded fixture shape.
    const types = r.events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["state_entered", "state_entered", "tool_call"]);
    expect(types).toEqual(
      expect.arrayContaining([
        "tool_result",
        "evidence_added",
        "assessment_updated",
        "approval_requested",
        "action_result",
        "explanation",
        "memory_written",
        "done",
      ]),
    );
    expect(r.events[0]!.state).toBe("TRIGGERED");
    expect(r.events[1]!.state).toBe("CASE_OPENED");

    // case_open ran instrumented under CASE_OPENED.
    const caseOpenCall = r.events.find((e) => e.type === "tool_call" && e.payload["tool"] === "case_open");
    expect(caseOpenCall!.state).toBe("CASE_OPENED");
    expect(caseOpenCall!.payload["args"]).toHaveProperty("as_of", AS_OF);

    // tool_call payloads use {tool,args}; tool_result {tool,result}.
    const gthCall = r.events.find((e) => e.type === "tool_call" && e.payload["tool"] === "get_transaction_history");
    expect(Object.keys(gthCall!.payload).sort()).toEqual(["args", "tool"]);
    expect((gthCall!.payload["args"] as Record<string, unknown>)["window"]).toEqual({ hours: 2 });
    const gthResult = r.events.find((e) => e.type === "tool_result" && e.payload["tool"] === "get_transaction_history");
    expect(gthResult!.payload["result"]).toHaveProperty("ok", true);
    expect(gthResult!.payload["result"]).toHaveProperty("via", "mcp");
    expect(gthResult!.payload["result"]).toHaveProperty("as_of", AS_OF);

    // No baseline call for the multi-txn shape; exactly 3 gather graph tools.
    const tools = r.events
      .filter((e) => e.type === "tool_call")
      .map((e) => e.payload["tool"] as string);
    expect(tools).not.toContain("get_baseline_deviation");
    expect(tools.filter((t) => t !== "request_evidence")).toEqual(
      expect.arrayContaining([
        "case_open",
        "resolve_trigger",
        "get_transaction_history",
        "find_shared_entity_rings",
        "find_prior_cases",
      ]),
    );

    // Evidence: 3 independent categories, deterministic ids, fixture weights.
    const cats = r.evidence.map((e) => e.category);
    expect(cats.sort()).toEqual(["device_identity", "prior_cases", "txn_behavior"]);
    expect(r.evidence.map((e) => e.id)).toEqual(["ev_001", "ev_002", "ev_003"]);
    expect(r.evidence.map((e) => e.weight_hint)).toEqual([0.7, 0.65, 0.5]);
    expect(r.evidence.every((e) => e.supports.includes("card_testing"))).toBe(true);

    // Single sufficient assessment (no evidence round).
    expect(r.answer.evidence_requests).toEqual([]);
    expect(r.rounds).toBe(0);
    expect(r.stopDecision).toEqual({ stop: true, reason: "sufficient_evidence" });
    expect(r.answer.stop_reason).toContain("three independent evidence categories");

    // Budget: open + 3 gather + assessment + 2 records (BLOCK_CARD L1,
    // FILE_REPORT L2 — shared device ring makes SAR required) = 7, exactly
    // matching recorded fixture HHG-910's `tool_calls: 7`.
    expect(r.toolCalls).toBe(7);
    expect(r.answer.tool_calls).toBe(r.toolCalls);

    // Verdict/actions: high conviction → BLOCK_CARD (L1) + auto actions.
    expect(r.answer.case.verdict).toBe("fraud");
    expect(r.answer.case.status).toBe("escalated");
    expect(r.answer.case.pattern).toBe("card_testing");
    expect(r.answer.case.affected_txn_ids).toEqual(["9900001", "9900002", "9900003", "9900004"]);
    expect(r.answer.case.first_suspicious_txn_id).toBe("9900001");
    expect(r.answer.case.connected_card_ids).toEqual(["C09002-K1"]);
    expect(r.answer.case.connected_device_profiles).toEqual(["D000731"]);
    expect(r.answer.case.exposure_usd).toBe(264.72);
    // Fake backend: nothing was written to any graph, so the answer reports
    // it honestly (the ledger's synthetic id is not echoed as a real one).
    expect(r.answer.case.graph_case_id).toBe("");
    expect(r.answer.case.written_to_graph).toBe(false);
    expect(r.answer.case.similar_prior_cases).toEqual(["CC-0500", "CC-0501"]);
    expect(r.answer.case.evidence).toHaveLength(3);
    expect(r.answer.case.evidence.every((e) => e.source === "graph")).toBe(true);

    const actions = r.recommendations.actions.map((a) => a.action);
    expect(actions).toContain("BLOCK_CARD");
    expect(actions).toContain("CREATE_CASE");
    expect(actions).toContain("MONITOR_CONNECTED_CARDS");
    // Shared device ring (D000731 links C09001-K1 ↔ C09002-K1) makes a SAR
    // required, so FILE_REPORT routes L2 like the recorded HHG-910.
    expect(actions).toContain("FILE_REPORT");
    expect(r.answer.sar.file).toBe(true);
    expect(r.answer.sar.subjects).toContain("C09001-K1");

    // approval_requested only for L1/L2; auto actions emit action_result only.
    const approvals = r.events.filter((e) => e.type === "approval_requested");
    const approvalActions = approvals.map((e) => e.payload["action"]);
    expect(approvalActions).toEqual(["BLOCK_CARD", "FILE_REPORT"]);
    expect(approvals[0]!.payload["route"]).toBe("L1");
    expect(approvals[1]!.payload["route"]).toBe("L2");
  });

  it("weak-assessment run enters the evidence round: request → respond → re-assessing", async () => {
    const r = await run({ script: WEAK_SCRIPT });

    const requested = r.events.filter((e) => e.type === "evidence_requested");
    expect(requested.length).toBeGreaterThanOrEqual(1);
    const first = requested[0]!;
    expect(first.payload["type"]).toBe("customer_validation");
    // Verification band: customer_validation beats analyst_info in round 1.
    expect((first.payload["target"] as { type: string; id: string }).type).toBe("Customer");
    expect((first.payload["target"] as { type: string; id: string }).id).toBe("C09001");
    expect(typeof first.payload["discrimination_score"]).toBe("number");
    expect(typeof first.payload["friction_cost"]).toBe("number");

    // request_evidence is split-instrumented: tool_call under EVIDENCE_PLANNING,
    // tool_result under AWAITING_EVIDENCE; the response resurfaces as evidence.
    const reqCall = r.events.find((e) => e.type === "tool_call" && e.payload["tool"] === "request_evidence");
    expect(reqCall!.state).toBe("EVIDENCE_PLANNING");
    const reqResult = r.events.find((e) => e.type === "tool_result" && e.payload["tool"] === "request_evidence");
    expect(reqResult!.state).toBe("AWAITING_EVIDENCE");

    // Evidence round ≤ maxEvidenceRounds; a customer_response item appears.
    const customerCategories = r.evidence.filter((e) => e.category === "customer_response");
    expect(customerCategories.length).toBe(Math.min(r.rounds, 2));
    expect(r.rounds).toBeLessThanOrEqual(2);

    // asked_after_step points at the seq of the evidence_requested event.
    expect(r.answer.evidence_requests[0]!.asked_after_step).toBe(first.seq);

    // Whatever the simulated customer said, the machine finishes decisively.
    expect(["sufficient_evidence", "no_discriminating_evidence_available", "budget_exhausted"]).toContain(
      r.stopDecision.reason,
    );
    expect(r.events[r.events.length - 1]!.type).toBe("done");
    expect(r.answer.case.status).toMatch(/^(escalated|open|closed_fraud|closed_legitimate)$/);
  });

  it("budget exhaustion stops the run without ever requesting evidence", async () => {
    const r = await run({ maxToolCalls: 4 });

    expect(r.stopDecision).toEqual({ stop: true, reason: "budget_exhausted" });
    expect(r.answer.stop_reason).toContain("budget exhausted");
    expect(r.events.some((e) => e.type === "evidence_requested")).toBe(false);
    expect(r.answer.evidence_requests).toEqual([]);
    // 4 budget (case_open + 3 gather; resolve_trigger free) + 1 assessment
    // + 2 records (BLOCK_CARD + FILE_REPORT, SAR required on the shared ring).
    expect(r.toolCalls).toBe(7);
    expect(r.answer.tool_calls).toBe(r.toolCalls);
    // Still completes: decision + explanation + memory + done all emitted.
    for (const t of ["approval_requested", "explanation", "memory_written", "done"]) {
      expect(r.events.some((e) => e.type === t)).toBe(true);
    }
  });

  it("single-transaction shape triggers the conditional baseline-deviation step", async () => {
    const singleTxn = new SingleTxnMcpClient();
    const r = await runAgent({
      caseId: "HHG-WS4-2",
      asOf: AS_OF,
      trigger: TRIGGER,
      mcp: singleTxn,
      backend: "fake",
    });

    const tools = r.events
      .filter((e) => e.type === "tool_call")
      .map((e) => e.payload["tool"] as string);
    expect(tools).toContain("get_baseline_deviation");
    expect(r.evidence.some((e) => e.category === "txn_behavior" && e.source_tool === "get_baseline_deviation")).toBe(
      true,
    );
  });
});

class SingleTxnMcpClient implements McpClient {
  private readonly inner = new FakeMcpClient();
  async callTool(name: McpGraphToolName, args: Record<string, unknown>): Promise<unknown> {
    if (name === "get_transaction_history") {
      return {
        rows: [
          {
            txn_id: "9900004",
            ts: "2016-11-12T00:31:00Z",
            amount_usd: 259.98,
            product_cd: "C",
            channel: "online",
            risk_score: 0.57,
          },
        ],
        stats: { count: 1, total_amount_usd: 259.98, window: "2h" },
      };
    }
    if (name === "get_baseline_deviation") {
      return { amount_z: 4.1, geo_z: 0.3, device_z: 3.8, time_z: 1.2 };
    }
    return this.inner.callTool(name, args);
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
  runInstalledQuery(): Promise<Record<string, unknown>> {
    return Promise.reject(new Error("SingleTxnMcpClient: no runInstalledQuery in this test harness"));
  }
}
