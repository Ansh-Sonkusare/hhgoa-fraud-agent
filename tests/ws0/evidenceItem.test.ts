import { describe, it, expect } from "vitest";
import { EvidenceItemSchema } from "../../contracts/src/evidenceItem.js";

describe("EvidenceItemSchema", () => {
  const valid = {
    id: "ev_001",
    category: "customer_response",
    summary: "Customer denied making the flagged purchases",
    entities: [{ type: "Customer", id: "C09001" }],
    source_tool: "request_evidence",
    weight_hint: 0.6,
    supports: ["card_testing"],
    contradicts: [],
    ts: "2016-11-12T09:00:00Z",
  };

  it("accepts a valid evidence item", () => {
    expect(EvidenceItemSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const bad = { ...valid, category: "psychic_hunch" };
    expect(EvidenceItemSchema.safeParse(bad).success).toBe(false);
  });
});
