import { describe, it, expect } from "vitest";
// Relative import (not the "@hhgoa/contracts" package specifier) because
// this test file lives under tests/ws6, outside api/'s own node_modules —
// same convention tests/ws0 uses to reach contracts/src directly (see
// tests/ws0/fakes.test.ts). api/src files themselves use the package
// specifier fine, since api/node_modules/@hhgoa/contracts is the pnpm
// workspace symlink.
import type { AgentEvent } from "../../contracts/src/agentEvent.js";
import { ReplaySession } from "../../api/src/replaySession.js";
import type { RunRecording } from "../../api/src/runSource.js";

function makeRecording(): RunRecording {
  const events: AgentEvent[] = [
    { seq: 0, ts: "t0", case_id: "X", type: "state_entered", state: "TRIGGERED", payload: {} },
    {
      seq: 1,
      ts: "t1",
      case_id: "X",
      type: "approval_requested",
      state: "APPROVAL_ROUTING",
      payload: { action: "BLOCK_CARD", route: "L1", reason: "test" },
    },
    { seq: 2, ts: "t2", case_id: "X", type: "state_entered", state: "EXPLAINING", payload: {} },
    { seq: 3, ts: "t3", case_id: "X", type: "done", state: "DONE", payload: { stop_reason: "test" } },
  ];
  return {
    case_id: "X",
    events,
    // minimal but not schema-checked here — ReplaySession doesn't validate `answer`
    answer: {} as RunRecording["answer"],
  };
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

describe("ReplaySession (WS6)", () => {
  it("is idle until subscribed, then emits events in order and reaches done", async () => {
    const session = new ReplaySession(makeRecording(), 5);
    expect(session.getStatus()).toBe("idle");

    const seen: AgentEvent[] = [];
    session.subscribe((e) => seen.push(e));

    await waitFor(() => session.getStatus() === "done");
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("replays backlog to a late subscriber before live events", async () => {
    const session = new ReplaySession(makeRecording(), 5);
    session.subscribe(() => {});
    await waitFor(() => session.getStatus() === "done");

    const late: AgentEvent[] = [];
    session.subscribe((e) => late.push(e));
    // no new events will fire since the session is done; backlog replay is synchronous
    expect(late.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("tracks a pending approval until resolveApproval appends a synthetic action_result", async () => {
    const session = new ReplaySession(makeRecording(), 5);
    session.subscribe(() => {});
    await waitFor(() => session.getPendingApprovals().length === 1);
    expect(session.getPendingApprovals()[0]?.action).toBe("BLOCK_CARD");

    const resolved = session.resolveApproval("BLOCK_CARD", "approved");
    expect(resolved?.action).toBe("BLOCK_CARD");
    expect(session.getPendingApprovals()).toHaveLength(0);

    const events = session.getEmittedEvents();
    const synthetic = events.at(-1);
    expect(synthetic?.type).toBe("action_result");
    expect(synthetic?.payload["result"]).toBe("EXECUTED");
    expect(synthetic?.payload["synthetic"]).toBe(true);
  });

  it("resolveApproval returns null for an action with no pending approval", () => {
    const session = new ReplaySession(makeRecording(), 5);
    expect(session.resolveApproval("NOT_PENDING", "approved")).toBeNull();
  });
});
