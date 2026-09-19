import type { ToolResult, ToolVia } from "@hhgoa/contracts";

/** Tools that carry no `as_of` per their `contracts/src/tools.ts` signature
 * (`retrieve_policy`, `lookup_external` — static reference data, not
 * time-bearing) still populate the envelope's `as_of` field (required by
 * `toolEnvelope.ts`'s schema); this is the shared sentinel, matching
 * `contracts/src/fakes.ts`'s convention. */
export const NO_AS_OF = "n/a";

export function envelope<T>(
  tool: string,
  as_of: string,
  via: ToolVia,
  data: T,
  opts?: { evidence_refs?: string[]; truncated?: boolean; latency_ms?: number },
): ToolResult<T> {
  return {
    ok: true,
    tool,
    as_of,
    via,
    data,
    evidence_refs: opts?.evidence_refs ?? [],
    truncated: opts?.truncated ?? false,
    latency_ms: opts?.latency_ms ?? 0,
    error: null,
  };
}
