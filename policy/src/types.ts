import { z } from "zod";
import type { PolicyActionName, EvidenceRequestType } from "@hhgoa/contracts";

/**
 * The shape the agent populates and passes as `PolicyCheckInput.case_state`
 * / inside `ExecuteActionInput.params.case_state` (both typed as
 * `Record<string, unknown>` in the frozen contract — this is our own,
 * WS4/WS5-internal convention for what goes inside that bag, since we own
 * both sides of the call). Kept intentionally small and structured so
 * `engine.ts`'s prerequisite checks are pure and testable. Validated with
 * `CaseStateForPolicySchema` at the tool-adapter boundary instead of cast,
 * so a malformed `case_state` fails loudly with a zod error rather than
 * silently reading `undefined` through an `as` cast.
 */
export const CaseStateForPolicySchema = z.object({
  case_id: z.string(),
  /** Fraud probability the assessor currently holds, 0-1. */
  fraud_probability: z.number().min(0).max(1),
  /** Number of *independent* evidence categories consulted so far. */
  evidence_category_count: z.number().int().nonnegative(),
  /** Sum of absolute amounts of transactions believed part of the episode. */
  exposure_usd: z.number().nonnegative(),
  /** True once a customer has explicitly denied making the transaction(s). */
  customer_denied: z.boolean(),
  /** True once a customer has explicitly confirmed the transaction(s). */
  customer_confirmed: z.boolean(),
  /**
   * True once the cardholder was asked to verify (R1/R3) and no reply came.
   * R1's "verify first" has then been done, and R4 calls for declining the
   * flagged authorization. Optional so existing callers stay valid.
   */
  verification_unanswered: z.boolean().optional(),
  /** Count of this customer's *other* cards with confirmed fraud (R10). */
  confirmed_fraud_card_count: z.number().int().nonnegative(),
  /** True once credentials are confirmed compromised (R10 alternate gate). */
  credentials_confirmed_compromised: z.boolean(),
  /** Whether the evidence connects to a shared device/region/other card's fraud (R6, §3a). */
  shared_origin_connection: z.boolean(),
  /** Whether the pattern is coordinated/undocumented abuse (R9, §3a). */
  coordinated_or_undocumented: z.boolean(),
  /** Whether fraud is confirmed or strongly suspected (verdict-level gate for §3a). */
  fraud_confirmed_or_strongly_suspected: z.boolean(),
});
export type CaseStateForPolicy = z.infer<typeof CaseStateForPolicySchema>;

export interface ExecuteActionParams {
  case_state: CaseStateForPolicy;
  reason: string;
  [key: string]: unknown;
}

export interface RequestEvidenceContext {
  case_state: CaseStateForPolicy;
}

export type { PolicyActionName, EvidenceRequestType };
