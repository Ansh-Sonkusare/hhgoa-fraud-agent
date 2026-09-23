import { describe, it, expect } from "vitest";
import { SimulatedResponder, DatasetResponder } from "../../policy/src/evidence.js";
import { EvidenceItemSchema } from "../../contracts/src/evidenceItem.js";
import { EvidenceRequestTypeSchema } from "../../contracts/src/answerFile.js";

describe("SimulatedResponder (README Fraud Policy §5)", () => {
  const responder = new SimulatedResponder();

  it("reports a non-response for all 3 request types, with a valid EvidenceResponse", async () => {
    for (const type of EvidenceRequestTypeSchema.options) {
      const response = await responder.respond({
        type,
        target: { type: "Card", id: "C09999-K1" },
        reason: "test",
      });
      expect(response.request_type).toBe(type);
      // README §5 supplies no replies, so the truthful report is that none
      // arrived. An invented one is still an invention, however carefully it
      // is seeded.
      expect(response.responded).toBe(false);
      expect(response.response_text.length).toBeGreaterThan(0);
      const parsed = EvidenceItemSchema.safeParse(response.evidence);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
      expect(response.evidence.category).toBe("customer_response");
    }
  });

  it("never fabricates a reply: nothing is supported, contradicted or weighted", async () => {
    for (const type of EvidenceRequestTypeSchema.options) {
      const response = await responder.respond({
        type,
        target: { type: "Card", id: "C09999-K1" },
        reason: "test",
      });
      expect(response.evidence.supports).toEqual([]);
      expect(response.evidence.contradicts).toEqual([]);
      expect(response.evidence.weight_hint).toBe(0);
      // Nothing that reads as the cardholder having answered either way.
      expect(response.response_text).not.toMatch(/confirms|denies|did not make|completed successfully/i);
    }
  });

  it("is deterministic: the same (type, target, reason) always yields the same response", async () => {
    const request = { type: "customer_validation" as const, target: { type: "Card", id: "C0001-K1" }, reason: "same" };
    const a = await responder.respond(request);
    const b = await responder.respond(request);
    expect(a.response_text).toBe(b.response_text);
    expect(a.evidence.supports).toEqual(b.evidence.supports);
  });

  // Was the inverse of this: the responder used to pick between two scripted
  // outcomes on a hash bit, so different targets gave different answers. Being
  // a constant function is now the point -- a reply that varies with the target
  // id carries information about nothing, and it decided 6 of 8 false negatives
  // in a 35-case backtest.
  it("is a constant function: the target id cannot change what comes back", async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const response = await responder.respond({
        type: "customer_validation",
        target: { type: "Card", id: `C000${i}-K1` },
        reason: "vary",
      });
      outcomes.add(response.response_text);
    }
    expect(outcomes.size).toBe(1);
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
