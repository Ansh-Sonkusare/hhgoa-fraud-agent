import { describe, it, expect } from "vitest";
import { AgentEventSchema } from "../../contracts/src/agentEvent.js";

describe("AgentEventSchema", () => {
  const valid = {
    seq: 3,
    ts: "2016-11-12T00:31:05Z",
    case_id: "HHG-901",
    type: "tool_result",
    state: "INVESTIGATING",
    payload: { tool: "get_transaction_history", rows: 4 },
  };

  it("accepts a valid agent event", () => {
    expect(AgentEventSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const bad = { ...valid, type: "made_a_wish" };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown state", () => {
    const bad = { ...valid, state: "SLEEPING" };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
  });
});
