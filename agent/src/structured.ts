import type { z } from "zod";
import type { LlmClient } from "./llm.js";

/**
 * Structured-output-from-LLM helper (PRD §9.3: "structured QA"; §9.4).
 *
 * Pipeline, with hard guarantees for benchmark runs (PRD §13, §15):
 *   1. ask the LLM for JSON (jsonMode) matching a zod schema,
 *   2. zod-validate the raw text (tolérently, extracting a JSON object
 *      even when the model wraps it in prose),
 *   3. on failure do exactly ONE repair retry explaining the schema fields
 *      and the validation errors,
 *   4. if repair still fails, fall back to a deterministic `fallback` value
 *      so the run can never be held hostage by a flaky local model.
 *
 * The repair is bounded (never a loop) so a broken Ollama process cannot
 * wedge a benchmark run. All fields in the returned result make the depth
 * of the fallback auditable (`usedFallback`, `attempts`, `repaired`).
 */
export type ZodObjectOutput = z.ZodObject<z.ZodRawShape>;

export interface StructuredCallOptions<S extends ZodObjectOutput> {
  llm: LlmClient;
  schema: S;
  system: string;
  user: string;
  temperature?: number;
  /** Deterministic value used when the LLM output does not validate. */
  fallback: () => z.infer<S>;
  /**
   * Set to true when a repaired parse still failed and the fallback was
   * used (wholly internal bookkeeping; surfaced on the result object).
   */
  maxAttempts?: number;
}

export interface StructuredCallResult<T> {
  value: T;
  /** Number of LLM calls made (1 = clean, 2 = repaired, in {1,2}). */
  attempts: number;
  repaired: boolean;
  usedFallback: boolean;
  /** Raw model text(s) for auditability. */
  rawTexts: string[];
}

export function describeSchema<S extends ZodObjectOutput>(schema: S): string {
  return Object.keys(schema.shape).join(", ");
}

/**
 * Extract a JSON object from model text. Tolerates prose around JSON
 * (the common Ollama failure mode) by locating the first `{` and last `}`.
 */
export function extractJsonObject(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t) as unknown;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`no JSON object found in model output`);
  }
  return JSON.parse(t.slice(start, end + 1)) as unknown;
}

export async function structuredCall<S extends ZodObjectOutput>(
  opts: StructuredCallOptions<S>,
): Promise<StructuredCallResult<z.infer<S>>> {
  const llm = opts.llm;
  const attempt = async (
    userContent: string,
  ): Promise<{ text: string; ok: true; value: z.infer<S> } | { text: string; ok: false }> => {
    const res = await llm.complete({
      system: opts.system,
      messages: [{ role: "user" as const, content: userContent }],
      jsonMode: true,
      temperature: opts.temperature,
    });
    try {
      const parsed: unknown = extractJsonObject(res.text);
      const value = opts.schema.safeParse(parsed);
      if (value.success) return { text: res.text, ok: true, value: value.data };
      return { text: res.text, ok: false };
    } catch {
      return { text: res.text, ok: false };
    }
  };

  const rawTexts: string[] = [];
  const first = await attempt(opts.user);
  rawTexts.push(first.text);
  if (first.ok) {
    return { value: first.value, attempts: 1, repaired: false, usedFallback: false, rawTexts };
  }

  const repairUser = [
    `Your previous response was not valid JSON matching the required schema.`,
    ``,
    `Required fields: ${describeSchema(opts.schema)}`,
    `Required output must be a single JSON object with exactly those fields and valid values.`,
    ``,
    `Your previous response:`,
    first.text.slice(0, 600),
    ``,
    `Return corrected JSON now. Do not include anything but the JSON object.`,
  ].join("\n");

  const second = await attempt(repairUser);
  rawTexts.push(second.text);
  if (second.ok) {
    return { value: second.value, attempts: 2, repaired: true, usedFallback: false, rawTexts };
  }

  return {
    value: opts.fallback(),
    attempts: 2,
    repaired: false,
    usedFallback: true,
    rawTexts,
  };
}

/** Rough token estimate (characters/4, ~English). Used for context budgets. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}