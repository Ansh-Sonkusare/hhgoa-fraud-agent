import { z } from "zod";
import { AgentStateSchema } from "./state.js";

/** SSE event emitted by the agent (PRD §8.5). */
export const AgentEventTypeSchema = z.enum([
  "state_entered",
  "tool_call",
  "tool_result",
  "evidence_added",
  "assessment_updated",
  "evidence_requested",
  "approval_requested",
  "action_result",
  "explanation",
  "memory_written",
  "done",
  "error",
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  case_id: z.string(),
  type: AgentEventTypeSchema,
  state: AgentStateSchema,
  // why: payload shape varies per event type (tool args/results, evidence
  // items, assessments, etc.); a discriminated union would duplicate every
  // downstream schema here. Consumers narrow by `type`.
  payload: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;
