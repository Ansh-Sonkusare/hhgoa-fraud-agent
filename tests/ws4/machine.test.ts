import { describe, it, expect } from "vitest";
import { runAgent, createLlmClient } from "../../agent/src/agentFactory.js";
import { FakeMcpClient, type McpClient, type McpGraphToolName } from "../../agent/src/mcpClient.js";
import type { Trigger } from "../../contracts/src/tools.js";
import type { MockScriptEntry } from "../../agent/src/llm.js";

const AS_OF = "2016-11-12T00:35:00Z";
const TRIGGER: Trigger = { kind: "risk_score", risk_score: 0.78 };

async function run(
  overrides: { script?: MockScriptEntry[]; maxToolCalls?: number; calibrateAlerts?: boolean } = {},
) {
  return runAgent({
    calibrateAlerts: overrides.calibrateAlerts,
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
    // 168h, not 2h: a case is opened *after* the episode has run, not during
    // it, so a short lookback misses most of it. Measured over the 4665
    // confirmed-fraud closed cases, the oldest fraud transaction is a median
    // 22h old at opened_at but p95 is 109h; 72h fully covers 89.8% of cases
    // and 168h covers 97.8% (see LOOKBACK_HOURS in investigation.ts).
    expect((gthCall!.payload["args"] as Record<string, unknown>)["window"]).toEqual({ hours: 168 });
    const gthResult = r.events.find((e) => e.type === "tool_result" && e.payload["tool"] === "get_transaction_history");
    expect(gthResult!.payload["result"]).toHaveProperty("ok", true);
    expect(gthResult!.payload["result"]).toHaveProperty("via", "mcp");
    expect(gthResult!.payload["result"]).toHaveProperty("as_of", AS_OF);

    // No baseline call for the multi-txn shape. The sweep is a superset of the
    // original three graph tools since detect_patterns/compute_velocity/
    // retrieve_similar_cases/lookup_external joined it, so this asserts
    // containment rather than an exact list.
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

    // Evidence: four independent categories now, deterministic ids. `policy_match`
    // arrives from the GSQL pattern detectors (detect_patterns), which joined the
    // standard sweep after an audit against CHALLENGE_BRIEF's evidence list found
    // six catalog tools that no case ever called. More independent categories also
    // loosens the confidence cap, which is the point of counting them.
    const cats = r.evidence.map((e) => e.category);
    expect([...new Set(cats)].sort()).toEqual([
      "device_identity",
      "policy_match",
      "prior_cases",
      "txn_behavior",
    ]);
    // Ids stay stable and sequential in emission order.
    expect(r.evidence.map((e) => e.id)).toEqual(
      r.evidence.map((_, i) => `ev_${String(i + 1).padStart(3, "0")}`),
    );
    // ev_001 is the structural channel claim: the flagged charge is online, so
    // the card-present patterns are ruled out definitionally. It shares the
    // txn_behavior category with the card-testing detector, so items outnumber
    // independent categories.
    const structural = r.evidence.find((e) => e.summary.includes("card-not-present (online)"));
    expect(structural).toBeDefined();
    expect(structural?.contradicts).toContain("out_of_region_use");
    // The evidence points toward fraud, but only the detector that actually
    // identifies card testing (small authorizations then a large purchase)
    // names the pattern; the ring and prior-case items carry the generic
    // "fraud" label so they vote on the verdict without voting on the
    // diagnosis. See evidenceBuilder.ts — labelling every signal
    // `card_testing` held backtest pattern accuracy to 19%.
    expect(r.evidence.every((e) => !e.supports.includes("legitimate"))).toBe(true);
    // Aggregate per category: there is more than one txn_behavior item now, and a
    // Map built from the pairs keeps only the last, which quietly hid the label.
    const supportsByCat = new Map<string, string[]>();
    for (const e of r.evidence) {
      supportsByCat.set(e.category, [...(supportsByCat.get(e.category) ?? []), ...e.supports]);
    }
    expect(supportsByCat.get("txn_behavior")).toContain("card_testing");
    // The fixture card shares a single device profile. One shared profile is
    // household-level overlap (1-2 on 47% of cleared vs 10% of fraud), so the
    // ring is recorded but does not vote.
    expect(supportsByCat.get("device_identity")).toEqual([]);

    // Single sufficient assessment (no evidence round).
    expect(r.answer.evidence_requests).toEqual([]);
    expect(r.rounds).toBe(0);
    expect(r.stopDecision).toEqual({ stop: true, reason: "sufficient_evidence" });
    // Four now, not three: detect_patterns contributes a `policy_match` category.
    expect(r.answer.stop_reason).toContain("four independent evidence categories");

    // Budget: open + 3 original gather + the 4 added sweep tools
    // (detect_patterns, compute_velocity, retrieve_similar_cases, and the
    // get_entity_profile that external enrichment reads the email domain from —
    // the history row cannot carry it, TransactionHistoryRow being a frozen
    // 6-field type) + the pre-window get_transaction_history that establishes
    // the card's home region before the lookback window (so a clone's away
    // purchases cannot define "home") + assessment + 2 records (BLOCK_CARD L1,
    // FILE_REPORT L2 — shared device ring makes SAR required) = 12.
    //
    // This deliberately no longer matches recorded fixture HHG-910's
    // `tool_calls: 7`. That fixture was recorded against a sweep that never
    // called the pattern detectors, case-memory retrieval or external lookup,
    // all of which CHALLENGE_BRIEF asks for; the extra coverage is worth losing
    // parity on a call count. Still well inside DEFAULT_MAX_TOOL_CALLS (25).
    expect(r.toolCalls).toBe(12);
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
    // The structural channel claim shares txn_behavior with the card-testing
    // detector, so items outnumber independent categories.
    expect(r.answer.case.evidence.length).toBeGreaterThanOrEqual(4);
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
    // L1/L2 actions wait for a human: the agent never reports them executed.
    const executed = r.events
      .filter((e) => e.type === "action_result" && e.payload["result"] === "EXECUTED")
      .map((e) => e.payload["action"]);
    expect(executed).not.toContain("BLOCK_CARD");
    expect(executed).not.toContain("FILE_REPORT");
  });

  it("weak-assessment run enters the evidence round: request → respond → re-assessing", async () => {
    const r = await run({ script: WEAK_SCRIPT, calibrateAlerts: false });

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

    // The round still happens and is still recorded, but an unanswered request
    // contributes no evidence: README §5 supplies no replies, so the responder
    // reports a non-response instead of inventing one, and the machine declines
    // to fold that into the store. Counting it would add an evidence category
    // that raises the confidence cap while saying nothing.
    expect(r.answer.evidence_requests.length).toBeGreaterThanOrEqual(1);
    const customerCategories = r.evidence.filter((e) => e.category === "customer_response");
    expect(customerCategories.length).toBe(0);
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
    // 4 budget (case_open + 3 gather; resolve_trigger free) + 1 assessment.
    // The 3 gather calls are the window history, the pre-window home-region
    // history and the ring query; the budget runs out before any profile or
    // precedent lookup. What was gathered argues fraud from one category
    // (txn_behavior), so the R1 guard (singleSignal.ts) files the mock's
    // p = 0.89 just below the fraud line: R1 then asks for verification
    // before any block, and FILE_REPORT must not appear on evidence the run
    // never gathered.
    expect(r.toolCalls).toBe(5);
    const cap = r.events.find((e) => e.type === "assessment_updated")!.payload["r1_single_signal_cap"] as
      | { independent_signals: string[]; fraud_probability_to: number }
      | undefined;
    expect(cap?.independent_signals).toEqual(["txn_behavior"]);
    expect(cap!.fraud_probability_to).toBeLessThan(0.7);
    const budgetActions = r.recommendations.actions.map((a) => a.action);
    expect(budgetActions).toContain("VERIFY_WITH_CUSTOMER");
    expect(budgetActions).not.toContain("BLOCK_CARD");
    expect(budgetActions).not.toContain("FILE_REPORT");
    expect(r.answer.tool_calls).toBe(r.toolCalls);
    // Still completes: explanation + memory + done all emitted. No block is
    // recommended, so there is nothing to put up for approval.
    expect(r.events.some((e) => e.type === "approval_requested")).toBe(false);
    for (const t of ["explanation", "memory_written", "done"]) {
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

  // Regression, three bugs one test. (a) `customer_denied` used to be set by
  // *any* fraud-supporting evidence response -- an analyst note or a timed-out
  // step-up included -- and a whole benchmark run closed as fraud at
  // probabilities as low as 0.25. (b) The reply was then applied a second time
  // in computeVerdict as an absolute veto, on top of the assessor having
  // already weighed it as evidence. (c) The reply itself was fabricated by a
  // hash bit, so (a) and (b) were amplifying noise: 6 of 6 confirmed-fraud
  // cases drawing a scripted "customer confirms" closed legitimate in a
  // 35-case backtest. Nothing is invented now, so an evidence round cannot
  // move the verdict off what the graph evidence supports.
  it("an unanswered evidence request never moves the verdict", async () => {
    const r = await run({ script: scriptAtProbability(0.55), calibrateAlerts: false });

    // The request was made and recorded, with the assumption stated plainly.
    const asked = r.answer.evidence_requests;
    expect(asked.length).toBeGreaterThanOrEqual(1);
    for (const q of asked) {
      expect(q.assumed_response).toMatch(/no .*(reply|outcome|analyst note) was (received|returned)/i);
      expect(q.assumed_response).not.toMatch(/confirms|denies|did not make|completed successfully/i);
    }

    // 0.55 is the assessor's own figure and it survives the round untouched:
    // no reply was received, so there is nothing to revise it with.
    expect(r.answer.case.fraud_probability).toBeCloseTo(0.55, 5);
    // Mid-band and unresolved -- not closed on a reply we made up.
    expect(r.answer.case.verdict).toBe("uncertain");
  });

  it("verdict follows the probability bands when no cardholder answer settles it", async () => {
    const high = await run({ script: scriptAtProbability(0.9), calibrateAlerts: false });
    expect(high.answer.evidence_requests).toEqual([]);
    expect(high.answer.case.verdict).toBe("fraud");

    // A legitimate reading still asks the cardholder (R3 closes only on a
    // confirmation); with no reply it is filed legitimate but left open, and
    // nothing is closed or allowed on the evidence alone.
    const low = await run({ script: scriptAtProbability(0.2), calibrateAlerts: false });
    expect(low.answer.evidence_requests.map((q) => q.type)).toEqual(["customer_validation"]);
    expect(low.answer.case.verdict).toBe("legitimate");
    expect(low.answer.case.status).toBe("open");
    const finalActions = low.answer.next_best_actions.final.map((a) => a.action);
    expect(finalActions).not.toContain("CLOSE_NO_FRAUD");
    expect(finalActions).not.toContain("ALLOW_TRANSACTION");
    expect(finalActions).toContain("MONITOR_CARD");
  });
});

function scriptAtProbability(p: number): MockScriptEntry[] {
  return [
    {
      json: {
        hypotheses: [
          { fraud_type: "card_testing", probability: p, supporting: [], contradicting: [] },
          { fraud_type: "legitimate", probability: 1 - p, supporting: [], contradicting: [] },
        ],
        risk_level: "MEDIUM",
        risk_score: p,
        confidence: 0.6,
        legit_hypothesis_probability: 1 - p,
      },
    },
  ];
}

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

describe("backtest isolation", () => {
  it("reports written_to_graph only when persistCase is wired", async () => {
    // The backtest scores the agent against closed cases living in the same
    // graph it would write to, so persisting mid-sample lets later cases read
    // earlier ones back as genuine prior cases. eval passes writeBackCase:false,
    // and agentFactory then leaves deps.persistCase undefined. This pins both
    // halves: wired => the write runs and is reported; absent => honest false.
    const { FraudInvestigationMachine } = await import("../../agent/src/machine.js");
    const { createToolProviders, createPolicyAdapters } = await import("../../agent/src/agentFactory.js");
    const { createMcpClient } = await import("../../agent/src/mcpClient.js");

    const build = async (persistCase?: unknown) =>
      new FraudInvestigationMachine({
        caseId: "HHG-WS4-1",
        asOf: AS_OF,
        trigger: TRIGGER,
        llm: createLlmClient("mock"),
        mcp: createMcpClient("fake"),
        providers: await createToolProviders("fake", "HHG-WS4-1"),
        policies: createPolicyAdapters(),
        persistCase,
      } as never).run();

    const seen: string[] = [];
    const wired = await build(async (req: { case_id: string }) => {
      seen.push(req.case_id);
      return { ok: true as const, graphCaseId: `GRAPH-${req.case_id}`, memoryWritten: true };
    });
    expect(seen).toEqual(["HHG-WS4-1"]);
    expect(wired.answer?.case.written_to_graph).toBe(true);

    const absent = await build(undefined);
    expect(absent.answer?.case.written_to_graph).toBe(false);
  });
});
