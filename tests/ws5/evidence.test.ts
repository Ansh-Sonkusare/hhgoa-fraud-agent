import { describe, it, expect } from "vitest";
import { SimulatedResponder, DatasetResponder } from "../../policy/src/evidence.js";
import { EvidenceItemSchema } from "../../contracts/src/evidenceItem.js";
import { EvidenceRequestTypeSchema } from "../../contracts/src/answerFile.js";

describe("SimulatedResponder (README Fraud Policy §5)", () => {
  const responder = new SimulatedResponder();

  it("responds to all 3 evidence-request types with a valid EvidenceResponse", async () => {
    for (const type of EvidenceRequestTypeSchema.options) {
      const response = await responder.respond({
        type,
        target: { type: "Card", id: "C09999-K1" },
        reason: "test",
      });
      expect(response.request_type).toBe(type);
      expect(response.responded).toBe(true);
      expect(response.response_text.length).toBeGreaterThan(0);
      const parsed = EvidenceItemSchema.safeParse(response.evidence);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
      expect(response.evidence.category).toBe("customer_response");
    }
  });

  it("is deterministic: the same (type, target, reason) always yields the same response", async () => {
    const request = { type: "customer_validation" as const, target: { type: "Card", id: "C0001-K1" }, reason: "same" };
    const a = await responder.respond(request);
    const b = await responder.respond(request);
    expect(a.response_text).toBe(b.response_text);
    expect(a.evidence.supports).toEqual(b.evidence.supports);
  });

  it("is not a constant function: different targets can yield different scripted outcomes", async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const response = await responder.respond({
        type: "customer_validation",
        target: { type: "Card", id: `C000${i}-K1` },
        reason: "vary",
      });
      outcomes.add(response.response_text);
    }
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it("never reads a hidden fraud label: the seed is only (type, target, reason)", () => {
    // Structural check: SimulatedResponder's public surface takes no
    // additional dataset/label argument beyond EvidenceRequestInput.
    expect(responder.respond.length).toBe(1);
  });
});

describe("DatasetResponder", () => {
  it("is a documented stub: rejects rather than fabricating a real dataset response", async () => {
    const responder = new DatasetResponder();
    await expect(
      responder.respond({ type: "analyst_info", target: { type: "Card", id: "C1" }, reason: "x" }),
    ).rejects.toThrow(/README does not supply/);
  });
});
