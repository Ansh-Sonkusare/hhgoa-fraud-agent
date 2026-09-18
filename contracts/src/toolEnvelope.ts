import { z } from "zod";

/**
 * The tool result envelope every tool returns (PRD §8.2).
 * `data` is tool-specific; pass its zod schema to `toolResultSchema()`
 * to get a fully-typed envelope schema for a given tool.
 */
export const ToolViaSchema = z.enum(["mcp", "local", "rag", "policy"]);
export type ToolVia = z.infer<typeof ToolViaSchema>;

export function toolResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    ok: z.boolean(),
    tool: z.string(),
    as_of: z.string(),
    via: ToolViaSchema,
    data: dataSchema,
    evidence_refs: z.array(z.string()),
    truncated: z.boolean(),
    latency_ms: z.number(),
    error: z.string().nullable(),
  });
}

export type ToolResult<T> = {
  ok: boolean;
  tool: string;
  as_of: string;
  via: ToolVia;
  data: T;
  evidence_refs: string[];
  truncated: boolean;
  latency_ms: number;
  error: string | null;
};

/** Envelope schema with `data: unknown`, for validating shape only. */
export const AnyToolResultSchema = toolResultSchema(z.unknown());
