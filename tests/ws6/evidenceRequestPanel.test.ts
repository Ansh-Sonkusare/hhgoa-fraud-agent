import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@hhgoa/contracts";
import { latestFraudProbability, noRequestExplanation } from "../../ui/lib/evidenceRequests.js";

let seq = 0;
const assessment = (hypotheses: Array<{ fraud_type: string; probability: number }>): AgentEvent => ({
  seq: seq++,
  ts: "2016-11-22T02:30:00Z",
  case_id: "HHG-T",
  type: "assessment_updated",
  state: "ASSESSING",
  payload: { assessment: { hypotheses } },
});

describe("Evidence requests panel: empty-state explanation", () => {
  it("HHG-006 shape: fraud 0.95 (0.8075 + 0.1425, legitimate 0.05) says none was needed, citing the 0.70 line", () => {
    const events = [
      assessment([
        { fraud_type: "card_not_present_new_device", probability: 0.8075 },
        { fraud_type: "account_takeover", probability: 0.1425 },
        { fraud_type: "legitimate", probability: 0.05 },
      ]),
    ];
    expect(latestFraudProbability(events)).toBeCloseTo(0.95, 10);
    const text = noRequestExplanation(events)!;
    expect(text).toContain("0.95");
    expect(text).toContain("None was needed");
    expect(text).toContain("0.70");
  });

  it("uses the latest assessment, not the first", () => {
    const events = [
      assessment([{ fraud_type: "card_testing", probability: 0.2 }, { fraud_type: "legitimate", probability: 0.8 }]),
      assessment([{ fraud_type: "card_testing", probability: 0.9 }, { fraud_type: "legitimate", probability: 0.1 }]),
    ];
    expect(latestFraudProbability(events)).toBeCloseTo(0.9, 10);
  });

  it("does not claim 'none was needed' below 0.70: it states the band and that nothing was requested", () => {
    const mid = noRequestExplanation([assessment([{ fraud_type: "x", probability: 0.55 }, { fraud_type: "legitimate", probability: 0.45 }])])!;
    expect(mid).toContain("0.55");
    expect(mid).toContain("R1");
    expect(mid).not.toContain("None was needed");

    const low = noRequestExplanation([assessment([{ fraud_type: "x", probability: 0.2 }, { fraud_type: "legitimate", probability: 0.8 }])])!;
    expect(low).toContain("0.20");
    expect(low).toContain("R3");
    expect(low).not.toContain("None was needed");
  });

  it("returns null while the run has no assessment, so the panel keeps its generic text", () => {
    expect(latestFraudProbability([])).toBeNull();
    expect(noRequestExplanation([])).toBeNull();
    expect(noRequestExplanation([assessment([])])).toBeNull();
  });
});
