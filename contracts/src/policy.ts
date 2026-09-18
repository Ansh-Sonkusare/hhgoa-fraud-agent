import { z } from "zod";
import { PolicyActionNameSchema, ApprovalRouteSchema, EvidenceRequestTypeSchema } from "./answerFile.js";
import type { EvidenceItem } from "./evidenceItem.js";

/**
 * Policy engine contracts (PRD §8.4, §10). The real bank policy.yaml is
 * WS5's job (`policy/policy.yaml`); this file only types the shapes that
 * cross the contracts boundary.
 */

export const PolicyCheckResultSchema = z.object({
  allowed: z.boolean(),
  approval_route: ApprovalRouteSchema,
  missing_prerequisites: z.array(z.string()),
  sar_required: z.boolean(),
});
export type PolicyCheckResult = z.infer<typeof PolicyCheckResultSchema>;

export interface PolicyCheckInput {
  action_or_request: string;
  case_state: Record<string, unknown>;
}

export const ExecuteActionResultSchema = z.enum([
  "EXECUTED",
  "PENDING_APPROVAL",
  "DENIED",
]);
export type ExecuteActionResult = z.infer<typeof ExecuteActionResultSchema>;

export interface ExecuteActionInput {
  action: z.infer<typeof PolicyActionNameSchema>;
  params: Record<string, unknown>;
}

export const EvidenceResponseSchema = z.object({
  request_type: EvidenceRequestTypeSchema,
  responded: z.boolean(),
  response_text: z.string(),
  evidence: z.custom<EvidenceItem>(),
});
export type EvidenceResponse = z.infer<typeof EvidenceResponseSchema>;

export interface EvidenceRequestInput {
  type: z.infer<typeof EvidenceRequestTypeSchema>;
  target: { type: string; id: string };
  reason: string;
}

/** Simulates or replays a response to `request_evidence` (PRD §10.4). */
export interface EvidenceResponder {
  respond(request: EvidenceRequestInput): Promise<EvidenceResponse>;
}

/** Routes an action requiring human sign-off to a human (PRD §10.4). */
export interface ApprovalChannel {
  requestApproval(input: {
    case_id: string;
    action: z.infer<typeof PolicyActionNameSchema>;
    route: z.infer<typeof ApprovalRouteSchema>;
    reason: string;
  }): Promise<"approved" | "rejected" | "pending">;
}

/**
 * Minimal shape of `policy/policy.yaml` (PRD §10.1). Values here are
 * placeholder types, not the real bank policy — WS5 owns the actual YAML
 * and its real thresholds/routes/roles.
 */
export const PolicyActionConfigSchema = z.object({
  executable_by_agent: z.boolean(),
  approval_route: ApprovalRouteSchema.or(z.literal("none")),
  prerequisites: z.record(z.string(), z.unknown()).optional(),
});
export type PolicyActionConfig = z.infer<typeof PolicyActionConfigSchema>;

export const PolicyEvidenceRequestConfigSchema = z.object({
  friction_cost: z.number(),
  approval_route: ApprovalRouteSchema.or(z.literal("none")),
});
export type PolicyEvidenceRequestConfig = z.infer<
  typeof PolicyEvidenceRequestConfigSchema
>;

export const PolicyConfigSchema = z.object({
  actions: z.record(z.string(), PolicyActionConfigSchema),
  evidence_requests: z.record(z.string(), PolicyEvidenceRequestConfigSchema),
  sar: z.object({ required_if: z.string() }),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
