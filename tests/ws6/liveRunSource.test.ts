import { describe, it, expect } from "vitest";
// Relative imports — same convention as the other tests/ws6 files (they live
// outside api/node_modules; api/src files use the "@hhgoa/contracts" package
// specifier via the pnpm workspace symlink).
import type { AgentEvent } from "../../contracts/src/agentEvent.js";
import type { Trigger } from "../../contracts/src/tools.js";
import {
  LiveRunSource,
  buildTriggerFromCasePack,
  type LiveRunner,
} from "../../api/src/liveRunSource.js";
import { LiveSession } from "../../api/src/replaySession.js";
import { CASE_PACK } from "../../api/src/data/casePack.js";
import { FixtureRunSource } from "../../api/src/runSource.js";

const fixtureAnswer = new FixtureRunSource().getRecording("HHG-910")?.answer;

function makeAgentEvents(caseId = "X"): AgentEvent[] {
  const ts = new Date().toISOString();
  return [
    { seq: 0, ts, case_id: caseId, type: "state_entered", state: "TRIGGERED", payload: {} },
    { seq: 1, ts, case_id: caseId, type: "state_entered", state: "INVESTIGATING", payload: {} },
    {
      seq: 2,
      ts,
      case_id: caseId,
      type: "approval_requested",
      state: "APPROVAL_ROUTING",
      payload: { action: "BLOCK_CARD", route: "L1", reason: "test" },
    },
    { seq: 3, ts, case_id: caseId, type: "done", state: "DONE", payload: { stop_reason: "test" } },
  ];
}

interface FakeRunnerHandle {
  runner: LiveRunner;
  calls(): number;
  received: Array<{ caseId: string; asOf: string; trigger: unknown }>;
}

function makeRunner(options: { events?: AgentEvent[]; answer?: unknown; failOnce?: boolean } = {}): FakeRunnerHandle {
  const events = options.events ?? makeAgentEvents();
  const answer = (options.answer ?? fixtureAnswer) as NonNullable<typeof fixtureAnswer>;
  const received: FakeRunnerHandle["received"] = [];
  let callCount = 0;
  const runner: LiveRunner = async (opts, onEvent) => {
    callCount += 1;
    received.push({ caseId: opts.caseId, asOf: opts.asOf, trigger: opts.trigger as unknown });
    if (options.failOnce && callCount === 1) throw new Error("boom");
    for (const event of events) onEvent({ ...event, case_id: opts.caseId });
    return { answer };
  };
  return { runner, calls: () => callCount, received };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("buildTriggerFromCasePack (WS6)", () => {
  it("maps risk_score entries", () => {
    const entry = CASE_PACK.find((c) => c.case_id === "HHG-001")!;
    expect(buildTriggerFromCasePack(entry)).toEqual({
      kind: "risk_score",
      txn_id: "3514030",
      card_id: "C12382-K1",
      risk_score: 0.61,
    });
  });

  it("maps customer_report entries", () => {
    const entry = CASE_PACK.find((c) => c.case_id === "HHG-003")!;
    const trigger = buildTriggerFromCasePack(entry);
    expect(trigger).toMatchObject({
      kind: "customer_report",
      customer_id: "C08623",
      txn_ids: ["3530164"],
    });
    expect((trigger as { text: string }).text).toContain("never made");
  });

  it("maps analyst_request entries", () => {
    const entry = CASE_PACK.find((c) => c.case_id === "HHG-014")!;
    const trigger = buildTriggerFromCasePack(entry);
    expect(trigger).toMatchObject({
      kind: "analyst_request",
      entity: { type: "Card", id: "C13487-K1" },
    });
    expect((trigger as { question: string }).question).toContain("Analyst request");
  });
});

describe("LiveRunSource (WS6)", () => {
  it("starts from the 20 case-pack cases", () => {
    const source = new LiveRunSource({ runner: makeRunner().runner });
    expect(source.listKnownCaseIds()).toHaveLength(20);
    expect(source.supports("HHG-001")).toBe(true);
    expect(source.supports("HHG-021")).toBe(false);
  });

  it("registers ad-hoc cases and runs them with the submitted trigger", async () => {
    const handle = makeRunner();
    const source = new LiveRunSource({ runner: handle.runner });
    const trigger: Trigger = {
      kind: "customer_report",
      customer_id: "C90000",
      txn_ids: ["999"],
      text: "adhoc!",
    };
    expect(source.supports("ADHOC-abc")).toBe(false);
    source.registerAdhoc("ADHOC-abc", trigger, "2017-01-01T00:00:00Z");
    expect(source.supports("ADHOC-abc")).toBe(true);
    expect(source.listKnownCaseIds()).toContain("ADHOC-abc");

    source.start("ADHOC-abc");
    await waitFor(() => source.getStatus("ADHOC-abc") === "done");
    expect(handle.received[0]).toEqual({
      caseId: "ADHOC-abc",
      asOf: "2017-01-01T00:00:00Z",
      trigger,
    });
  });

  it("streams events to subscribers and materializes a recording once done", async () => {
    const handle = makeRunner();
    const source = new LiveRunSource({ runner: handle.runner });
    expect(source.getStatus("HHG-001")).toBe("idle");
    expect(source.getRecording("HHG-001")).toBeNull();

    const seen: AgentEvent[] = [];
    source.subscribe("HHG-001", (e) => seen.push(e));

    await waitFor(() => source.getStatus("HHG-001") === "done");
    expect(handle.calls()).toBe(1);
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    const recording = source.getRecording("HHG-001");
    expect(recording).not.toBeNull();
    expect(recording?.case_id).toBe("HHG-001");
    expect(recording?.events).toHaveLength(4);
    expect(recording?.events.at(-1)?.type).toBe("done");
    expect(recording?.answer?.case_id).toBe("HHG-910");

    // The runner received the case-pack trigger and opened_at as asOf.
    expect(handle.received[0]?.caseId).toBe("HHG-001");
    expect(handle.received[0]?.asOf).toBe("2016-12-05T01:55:28Z");
  });

  it("has the answer stored by the time subscribers see DONE", async () => {
    // The real runner emits DONE and only then returns the answer (after
    // write-back); the UI fetches the answer the moment DONE arrives.
    const events = makeAgentEvents();
    const runner: LiveRunner = async (opts, onEvent) => {
      for (const event of events) onEvent({ ...event, case_id: opts.caseId });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { answer: fixtureAnswer as NonNullable<typeof fixtureAnswer> };
    };
    const source = new LiveRunSource({ runner });
    const answerAtDone: Array<unknown> = [];
    source.subscribe("HHG-001", (e) => {
      if (e.type === "done") answerAtDone.push(source.getRecording("HHG-001")?.answer ?? null);
    });
    await waitFor(() => answerAtDone.length === 1);
    expect(answerAtDone[0]).not.toBeNull();
    expect(source.getStatus("HHG-001")).toBe("done");
  });

  it("start is idempotent while running or done", async () => {
    const handle = makeRunner();
    const source = new LiveRunSource({ runner: handle.runner });
    source.start("HHG-001");
    source.start("HHG-001");
    source.subscribe("HHG-001", () => {}); // also calls start
    await waitFor(() => source.getStatus("HHG-001") === "done");
    source.start("HHG-001");
    expect(handle.calls()).toBe(1);
  });

  it("replays the backlog to a late subscriber", async () => {
    const handle = makeRunner();
    const source = new LiveRunSource({ runner: handle.runner });
    source.subscribe("HHG-001", () => {});
    await waitFor(() => source.getStatus("HHG-001") === "done");

    const late: AgentEvent[] = [];
    source.subscribe("HHG-001", (e) => late.push(e));
    expect(late.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("supports synthetic approvals through LiveSession, sequenced after the run", async () => {
    const handle = makeRunner();
    const source = new LiveRunSource({ runner: handle.runner });
    const session = new LiveSession(source, "HHG-001");
    session.subscribe(() => {});
    await waitFor(() => session.getStatus() === "done");

    expect(session.getPendingApprovals().map((p) => p.action)).toEqual(["BLOCK_CARD"]);
    const resolved = session.resolveApproval("BLOCK_CARD", "approved");
    expect(resolved?.action).toBe("BLOCK_CARD");
    expect(session.getPendingApprovals()).toHaveLength(0);

    const events = source.getEvents("HHG-001");
    const synthetic = events.at(-1);
    expect(synthetic?.type).toBe("action_result");
    expect(synthetic?.seq).toBe(4); // max recorded seq (3) + 1
    expect(synthetic?.payload["result"]).toBe("EXECUTED");
    expect(synthetic?.payload["synthetic"]).toBe(true);

    // Unknown action -> null, stream unchanged.
    expect(session.resolveApproval("NOT_PENDING", "approved")).toBeNull();
    expect(source.getEvents("HHG-001")).toHaveLength(5);
  });

  it("surfaces run failures as status error and allows a retry", async () => {
    const handle = makeRunner({ failOnce: true });
    const source = new LiveRunSource({ runner: handle.runner });
    source.subscribe("HHG-001", () => {});
    await waitFor(() => source.getStatus("HHG-001") === "error");
    expect(source.getLastError("HHG-001")).toBe("boom");
    expect(source.getRecording("HHG-001")).toBeNull();

    // Reopening a case after an error starts a fresh run.
    source.start("HHG-001");
    await waitFor(() => source.getStatus("HHG-001") === "done");
    expect(handle.calls()).toBe(2);
    expect(source.getRecording("HHG-001")).not.toBeNull();
  });
});