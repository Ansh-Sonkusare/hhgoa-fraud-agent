import { describe, expect, it } from "vitest";
import { envelope, NO_AS_OF } from "../../rag/src/envelope.js";

describe("envelope", () => {
  it("fills sensible defaults for optional fields", () => {
    const r = envelope("retrieve_policy", NO_AS_OF, "rag", { chunks: [] });
    expect(r).toEqual({
      ok: true,
      tool: "retrieve_policy",
      as_of: "n/a",
      via: "rag",
      data: { chunks: [] },
      evidence_refs: [],
      truncated: false,
      latency_ms: 0,
      error: null,
    });
  });

  it("passes through opts (evidence_refs, truncated, latency_ms)", () => {
    const r = envelope("retrieve_similar_cases", "2016-09-01 00:00:00", "rag", { cases: [] }, {
      evidence_refs: ["cc-1"],
      truncated: true,
      latency_ms: 42,
    });
    expect(r.evidence_refs).toEqual(["cc-1"]);
    expect(r.truncated).toBe(true);
    expect(r.latency_ms).toBe(42);
    expect(r.as_of).toBe("2016-09-01 00:00:00");
  });

  it("uses the shared n/a sentinel for non-time-bearing tools", () => {
    expect(NO_AS_OF).toBe("n/a");
  });
});