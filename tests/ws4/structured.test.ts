import { describe, it, expect } from "vitest";
import { z } from "zod";
import { structuredCall, extractJsonObject, describeSchema, estimateTokens } from "../../agent/src/structured.js";
import { MockLlmClient } from "../../agent/src/llm.js";

const Schema = z.object({
  fraud_type: z.string(),
  probability: z.number(),
});

describe("structuredCall", () => {
  it("parses clean JSON on the first attempt", async () => {
    const llm = new MockLlmClient([{ json: { fraud_type: "card_testing", probability: 0.8 } }]);
    const out = await structuredCall({
      llm,
      schema: Schema,
      system: "s",
      user: "u",
      fallback: () => ({ fraud_type: "none", probability: 0.5 }),
    });
    expect(out.attempts).toBe(1);
    expect(out.repaired).toBe(false);
    expect(out.usedFallback).toBe(false);
    expect(out.value.fraud_type).toBe("card_testing");
  });

  it("repairs on the second call when the first response fails schema validation", async () => {
    const llm = new MockLlmClient([
      { json: { fraud_type: 7, probability: 0.8 } }, // valid JSON, wrong types
      { json: { fraud_type: "card_testing", probability: 0.8 } },
    ]);
    const out = await structuredCall({
      llm,
      schema: Schema,
      system: "s",
      user: "u",
      fallback: () => ({ fraud_type: "none", probability: 0.5 }),
    });
    expect(out.attempts).toBe(2);
    expect(out.repaired).toBe(true);
    expect(out.usedFallback).toBe(false);
    expect(out.value.fraud_type).toBe("card_testing");
    expect(out.rawTexts).toHaveLength(2);
  });

  it("falls back to the deterministic value when repair fails, saying so", async () => {
    const llm = new MockLlmClient([{ text: "definitely not json" }, { text: "still not json" }]);
    const out = await structuredCall({
      llm,
      schema: Schema,
      system: "s",
      user: "u",
      fallback: () => ({ fraud_type: "card_testing", probability: 0.55 }),
    });
    expect(out.usedFallback).toBe(true);
    expect(out.value).toEqual({ fraud_type: "card_testing", probability: 0.55 });
    expect(out.rawTexts).toHaveLength(2);
  });
});

describe("extractJsonObject", () => {
  it("accepts bare objects", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("locates the first { and last } in prose", () => {
    expect(extractJsonObject('Here: {"a": 1} thanks')).toEqual({ a: 1 });
  });
  it("throws when no JSON object exists", () => {
    expect(() => extractJsonObject("nope")).toThrow(/no JSON object/);
  });
});

describe("describeSchema", () => {
  it("lists the schema field names via Object.keys (no model .toJSON dependency)", () => {
    expect(describeSchema(Schema).split(", ").sort()).toEqual(["fraud_type", "probability"]);
  });
});

describe("estimateTokens", () => {
  it("returns a deterministic, positive estimate for non-empty text", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("a")).toBe(1);
  });
})