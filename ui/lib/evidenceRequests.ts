import type { AgentEvent } from "./types";

// Empty-state wording for the Evidence requests panel, kept out of the
// component so it can be unit-tested (tests/ws6/evidenceRequestPanel.test.ts).

/**
 * The agent's current fraud probability: everything that is not the
 * `legitimate` hypothesis in the latest `assessment_updated` event. Null while
 * the run has not produced an assessment yet.
 */
export function latestFraudProbability(events: AgentEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "assessment_updated") continue;
    const assessment = event.payload["assessment"] as
      | { hypotheses?: Array<{ fraud_type?: string; probability?: number }> }
      | undefined;
    const hypotheses = assessment?.hypotheses;
    if (!hypotheses || hypotheses.length === 0) return null;
    return hypotheses
      .filter((h) => h.fraud_type !== "legitimate" && typeof h.probability === "number")
      .reduce((sum, h) => sum + (h.probability as number), 0);
  }
  return null;
}

/**
 * Why the panel is empty, in words that use only what the run produced: the
 * assessed fraud probability and the bands the agent itself uses to decide
 * whether to ask (R3 at or below 0.40, R1 below 0.70, at or above 0.70 a
 * block needs no verification). Returns null while there is no assessment, so
 * the caller keeps its generic text and does not claim anything about a run
 * that is still going.
 */
export function noRequestExplanation(events: AgentEvent[]): string | null {
  const p = latestFraudProbability(events);
  if (p === null) return null;
  const prob = p.toFixed(2);
  if (p >= 0.7) {
    return `None was needed: the agent's fraud probability is ${prob}, at or above the 0.70 block threshold, so R1's verify-before-blocking step does not apply.`;
  }
  if (p > 0.4) {
    return `The agent's fraud probability is ${prob}, below the 0.70 block threshold (R1 range), and it did not request anything.`;
  }
  return `The agent's fraud probability is ${prob}, in the legitimate range (R3), and it did not request anything.`;
}
