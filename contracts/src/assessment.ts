import { z } from "zod";

/** Structured assessment the agent produces and code validates (PRD §9.3). */
export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const HypothesisSchema = z.object({
  fraud_type: z.string(),
  probability: z.number().min(0).max(1),
  supporting: z.array(z.string()),
  contradicting: z.array(z.string()),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const MissingEvidenceSchema = z.object({
  what: z.string(),
  why: z.string(),
  would_change_decision: z.boolean(),
});
export type MissingEvidence = z.infer<typeof MissingEvidenceSchema>;

export const SufficiencySchema = z.object({
  sufficient: z.boolean(),
  missing: z.array(MissingEvidenceSchema),
  stop_reason: z.string().nullable(),
});
export type Sufficiency = z.infer<typeof SufficiencySchema>;

export const AssessmentSchema = z.object({
  hypotheses: z.array(HypothesisSchema),
  risk_level: RiskLevelSchema,
  risk_score: z.number(),
  confidence: z.number().min(0).max(1),
  sufficiency: SufficiencySchema,
  legit_hypothesis_probability: z.number().min(0).max(1),
});
export type Assessment = z.infer<typeof AssessmentSchema>;
