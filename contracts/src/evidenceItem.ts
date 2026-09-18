import { z } from "zod";

/** Evidence item (PRD §8.3). */
export const EvidenceCategorySchema = z.enum([
  "graph_structure",
  "txn_behavior",
  "device_identity",
  "prior_cases",
  "policy_match",
  "external",
  "customer_response",
]);
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;

export const EvidenceEntityRefSchema = z.object({
  type: z.string(),
  id: z.string(),
});
export type EvidenceEntityRef = z.infer<typeof EvidenceEntityRefSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string(),
  category: EvidenceCategorySchema,
  summary: z.string(),
  entities: z.array(EvidenceEntityRefSchema),
  source_tool: z.string(),
  weight_hint: z.number(),
  supports: z.array(z.string()),
  contradicts: z.array(z.string()),
  ts: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
