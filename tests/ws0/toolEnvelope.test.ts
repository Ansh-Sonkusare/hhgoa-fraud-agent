import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toolResultSchema } from "../../contracts/src/toolEnvelope.js";

describe("toolResultSchema", () => {
  const schema = toolResultSchema(z.string());

  it("accepts a well-formed envelope", () => {
    const result = schema.safeParse({
      ok: true,
      tool: "get_entity_profile",
      as_of: "2016-11-12T00:00:00Z",
      via: "mcp",
      data: "hello",
      evidence_refs: [],
      truncated: false,
      latency_ms: 5,
      error: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope missing a required field", () => {
    const result = schema.safeParse({
      tool: "get_entity_profile",
      as_of: "2016-11-12T00:00:00Z",
      via: "mcp",
      data: "hello",
      evidence_refs: [],
      truncated: false,
      latency_ms: 5,
      error: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid via value", () => {
    const result = schema.safeParse({
      ok: true,
      tool: "get_entity_profile",
      as_of: "2016-11-12T00:00:00Z",
      via: "carrier_pigeon",
      data: "hello",
      evidence_refs: [],
      truncated: false,
      latency_ms: 5,
      error: null,
    });
    expect(result.success).toBe(false);
  });
});
