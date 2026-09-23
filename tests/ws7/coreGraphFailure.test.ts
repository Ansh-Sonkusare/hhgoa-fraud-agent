import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../contracts/src/index.js";
import { coreGraphFailure } from "../../eval/src/runner.js";

function toolResult(seq: number, tool: string, ok: boolean, error: string | null = null): AgentEvent {
  return {
    case_id: "CC-TEST",
    seq,
    ts: "2016-11-12 00:00:00",
    type: "tool_result",
    state: "INVESTIGATING",
    payload: { tool, result: { ok, tool, error } },
  } as AgentEvent;
}

describe("coreGraphFailure", () => {
  it("is null when every core graph read succeeded", () => {
    expect(
      coreGraphFailure([toolResult(1, "resolve_trigger", true), toolResult(2, "get_transaction_history", true)]),
    ).toBeNull();
  });

  it("reports a failed transaction-history read, e.g. TigerGraph out of memory", () => {
    const msg = coreGraphFailure([
      toolResult(1, "resolve_trigger", true),
      toolResult(2, "get_transaction_history", false, "System Memory in Critical state. Request aborted."),
    ]);
    expect(msg).toContain("get_transaction_history");
    expect(msg).toContain("System Memory in Critical state");
  });

  it("ignores failures of non-core tools (the run still has its core evidence)", () => {
    expect(
      coreGraphFailure([
        toolResult(1, "resolve_trigger", true),
        toolResult(2, "get_transaction_history", true),
        toolResult(3, "lookup_external", false, "no domain"),
      ]),
    ).toBeNull();
  });
});
