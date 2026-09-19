import { describe, it, expect } from "vitest";
import { EventLog } from "../../agent/src/events.js";

describe("EventLog", () => {
  it("assigns monotonically increasing seq per case and records the emitter state", () => {
    const log = new EventLog("HHG-EV-1");
    const a = log.emit("state_entered", "TRIGGERED", { trigger: {} });
    const b = log.emit("tool_call", "INVESTIGATING", { tool: "x" });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(a.case_id).toBe("HHG-EV-1");
    expect(a.state).toBe("TRIGGERED");
    expect(b.state).toBe("INVESTIGATING");
  });

  it("validates every emitted event against AgentEventSchema at emission time", () => {
    const log = new EventLog("HHG-EV-2");
    expect(() => log.emit("state_entered", "NOT_A_STATE" as never, {})).toThrow();
    log.emit("evidence_added", "INVESTIGATING", { evidence: { id: "ev_001" } });
    expect(log.count("evidence_added")).toBe(1);
  });

  it("list() returns a snapshot copy", () => {
    const log = new EventLog("HHG-EV-3");
    log.emit("state_entered", "DONE", {});
    const snapshot = log.list();
    snapshot.pop();
    expect(log.list()).toHaveLength(1);
  });

  it("subscribers receive each event in order and can unsubscribe", () => {
    const log = new EventLog("HHG-EV-4");
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.type));
    log.emit("state_entered", "TRIGGERED", {});
    off();
    log.emit("done", "DONE", {});
    expect(seen).toEqual(["state_entered"]);
  });
})