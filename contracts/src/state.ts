import { z } from "zod";

/** Agent state machine states (PRD §9.2). */
export const AgentStateSchema = z.enum([
  "TRIGGERED",
  "CASE_OPENED",
  "INVESTIGATING",
  "ASSESSING",
  "EVIDENCE_PLANNING",
  "AWAITING_EVIDENCE",
  "EVIDENCE_RECEIVED",
  "DECIDING",
  "APPROVAL_ROUTING",
  "EXPLAINING",
  "MEMORY_UPDATE",
  "DONE",
]);
export type AgentState = z.infer<typeof AgentStateSchema>;
