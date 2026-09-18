import { z } from "zod";

/**
 * AnswerFile — the ONE schema for `cases/<case_id>.json`, generated field for
 * field from README.md's "Answer Format" section (also reproduced in
 * PRD §13). If this file and the README ever disagree, the README wins.
 */

export const CaseStatusSchema = z.enum([
  "open",
  "closed_fraud",
  "closed_legitimate",
  "escalated",
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const VerdictSchema = z.enum(["fraud", "legitimate", "uncertain"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const PatternSchema = z.enum([
  "card_testing",
  "card_not_present_fraud",
  "card_not_present_new_device",
  "out_of_region_use",
  "account_takeover",
  "undocumented",
  "none",
]);
export type Pattern = z.infer<typeof PatternSchema>;

export const EvidenceSourceSchema = z.enum([
  "graph",
  "document",
  "customer",
  "external",
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const CaseEvidenceSchema = z.object({
  claim: z.string(),
  source: EvidenceSourceSchema,
  ref: z.string(),
  entity_ids: z.array(z.string()),
});
export type CaseEvidence = z.infer<typeof CaseEvidenceSchema>;

export const EvidenceRequestTypeSchema = z.enum([
  "customer_validation",
  "step_up_auth",
  "analyst_info",
]);
export type EvidenceRequestType = z.infer<typeof EvidenceRequestTypeSchema>;

export const EvidenceRequestSchema = z.object({
  type: EvidenceRequestTypeSchema,
  asked_after_step: z.number().int().nonnegative(),
  assumed_response: z.string(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

/** Fraud Policy §1 action names — identifiers must match exactly. */
export const PolicyActionNameSchema = z.enum([
  "ALLOW_TRANSACTION",
  "DECLINE_TRANSACTION",
  "MONITOR_CARD",
  "MONITOR_CONNECTED_CARDS",
  "WARN_CUSTOMER",
  "VERIFY_WITH_CUSTOMER",
  "STEP_UP_AUTH",
  "BLOCK_CARD",
  "BLOCK_ALL_CARDS",
  "GENERATE_REPORT",
  "CREATE_CASE",
  "FILE_REPORT",
  "ESCALATE_TO_ANALYST",
  "CLOSE_NO_FRAUD",
]);
export type PolicyActionName = z.infer<typeof PolicyActionNameSchema>;

export const ApprovalRouteSchema = z.enum(["auto", "L1", "L2"]);
export type ApprovalRoute = z.infer<typeof ApprovalRouteSchema>;

export const NextBestActionSchema = z.object({
  action: PolicyActionNameSchema,
  route: ApprovalRouteSchema,
  reason: z.string(),
});
export type NextBestAction = z.infer<typeof NextBestActionSchema>;

export const NextBestActionsSchema = z.object({
  initial: z.array(NextBestActionSchema),
  final: z.array(NextBestActionSchema),
  what_changed: z.string(),
});
export type NextBestActions = z.infer<typeof NextBestActionsSchema>;

export const SarSchema = z.object({
  file: z.boolean(),
  reason: z.string(),
  narrative: z.string(),
  subjects: z.array(z.string()),
  total_amount_usd: z.number(),
  activity_dates: z.array(z.string()),
});
export type Sar = z.infer<typeof SarSchema>;

export const CaseRecordSchema = z.object({
  status: CaseStatusSchema,
  verdict: VerdictSchema,
  fraud_probability: z.number().min(0).max(1),
  pattern: PatternSchema,
  pattern_description: z.string(),
  affected_txn_ids: z.array(z.string()),
  first_suspicious_txn_id: z.string(),
  connected_card_ids: z.array(z.string()),
  connected_device_profiles: z.array(z.string()),
  exposure_usd: z.number(),
  evidence: z.array(CaseEvidenceSchema),
  similar_prior_cases: z.array(z.string()),
  summary: z.string(),
  written_to_graph: z.boolean(),
  graph_case_id: z.string(),
});
export type CaseRecord = z.infer<typeof CaseRecordSchema>;

const AnswerFileShapeSchema = z.object({
  case_id: z.string(),
  case: CaseRecordSchema,
  evidence_requests: z.array(EvidenceRequestSchema),
  next_best_actions: NextBestActionsSchema,
  sar: SarSchema,
  stop_reason: z.string(),
  tool_calls: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  latency_s: z.number().nonnegative(),
});

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const AnswerFileSchema = AnswerFileShapeSchema.superRefine((val, ctx) => {
  // pattern_description required (non-empty) only when pattern is
  // "undocumented", else must be "".
  if (val.case.pattern === "undocumented") {
    if (val.case.pattern_description.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'case.pattern_description must be non-empty when pattern is "undocumented"',
        path: ["case", "pattern_description"],
      });
    }
  } else if (val.case.pattern_description !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'case.pattern_description must be "" unless pattern is "undocumented"',
      path: ["case", "pattern_description"],
    });
  }

  // legitimate verdict implies empty affected_txn_ids, zero exposure, no SAR.
  if (val.case.verdict === "legitimate") {
    if (val.case.affected_txn_ids.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'case.affected_txn_ids must be [] when verdict is "legitimate"',
        path: ["case", "affected_txn_ids"],
      });
    }
    if (val.case.exposure_usd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'case.exposure_usd must be 0 when verdict is "legitimate"',
        path: ["case", "exposure_usd"],
      });
    }
    if (val.sar.file !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sar.file must be false when verdict is "legitimate"',
        path: ["sar", "file"],
      });
    }
  }

  // sar.file === true requires the narrative (the report itself, per README).
  if (val.sar.file === true && val.sar.narrative.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sar.narrative is required when sar.file is true",
      path: ["sar", "narrative"],
    });
  }

  // sar.file === false implies the rest of sar is blank/zeroed.
  if (val.sar.file === false) {
    if (val.sar.narrative !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sar.narrative must be "" when sar.file is false',
        path: ["sar", "narrative"],
      });
    }
    if (val.sar.subjects.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sar.subjects must be [] when sar.file is false",
        path: ["sar", "subjects"],
      });
    }
    if (val.sar.total_amount_usd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sar.total_amount_usd must be 0 when sar.file is false",
        path: ["sar", "total_amount_usd"],
      });
    }
    if (val.sar.activity_dates.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sar.activity_dates must be [] when sar.file is false",
        path: ["sar", "activity_dates"],
      });
    }
  }

  // sar.file must agree with whether FILE_REPORT appears in the final actions.
  const finalHasFileReport = val.next_best_actions.final.some(
    (a) => a.action === "FILE_REPORT",
  );
  if (val.sar.file !== finalHasFileReport) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "sar.file must agree with whether FILE_REPORT appears in next_best_actions.final",
      path: ["sar", "file"],
    });
  }

  // next_best_actions.final equals initial (and what_changed is "nothing")
  // whenever no evidence was requested.
  if (val.evidence_requests.length === 0) {
    if (!deepEqual(val.next_best_actions.final, val.next_best_actions.initial)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "next_best_actions.final must equal initial when evidence_requests is empty",
        path: ["next_best_actions", "final"],
      });
    }
    if (val.next_best_actions.what_changed !== "nothing") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'next_best_actions.what_changed must be "nothing" when evidence_requests is empty',
        path: ["next_best_actions", "what_changed"],
      });
    }
  }
});

export type AnswerFile = z.infer<typeof AnswerFileShapeSchema>;
