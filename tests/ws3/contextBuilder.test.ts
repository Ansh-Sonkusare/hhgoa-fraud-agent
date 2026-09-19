import { describe, expect, it } from "vitest";
import {
  buildContextBundle,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type ContextBuildInput,
} from "../../rag/src/contextBuilder.js";
import { approxTokenCount } from "../../rag/src/tokenCount.js";

describe("buildContextBundle", () => {
  const input: ContextBuildInput = {
    query: "small online authorizations before a bigger purchase",
    patterns: [
      {
        pattern_id: "card_testing",
        name: "Card testing",
        required_evidence: ["txn_velocity_small_online_auths"],
        permitted_actions: ["DECLINE_TRANSACTION", "STEP_UP_AUTH"],
      },
    ],
    evidenceItems: [
      { id: "ev-1", summary: "3 authorizations under $5 in 30 minutes", category: "txn_velocity" },
      { id: "ev-2", summary: "customer denies the larger purchase", category: "customer" },
    ],
    policyChunks: [
      { id: "pc_0002", text: "R5 rule text", source_doc: "README", heading_path: "Fraud Policy > Rules > R5.", score: 0.91 },
      { id: "pc_0001", text: "card testing pattern text", source_doc: "README", heading_path: "The five known fraud patterns > 1.", score: 0.95 },
    ],
    priorCases: [
      { id: "CC-0100", summary_text: "prior case narration", outcome: "confirmed_fraud", score: 0.7, overlap_reason: "same card" },
      { id: "CC-0200", summary_text: "another narration", outcome: "cleared", score: 0.9, overlap_reason: "same pattern" },
    ],
  };

  it("orders: pattern block, evidence, then chunks/cases by score desc", () => {
    const bundle = buildContextBundle(input);
    expect(bundle.items.map((i) => i.id)).toEqual([
      "pattern:card_testing",
      "ev-1",
      "ev-2",
      "pc_0001", // 0.95 > 0.91
      "pc_0002",
      "CC-0200", // 0.9 > 0.7
      "CC-0100",
    ]);
  });

  it("keeps total_tokens under the budget and stamps provenance", () => {
    const bundle = buildContextBundle(input, 6000);
    expect(bundle.total_tokens).toBeLessThanOrEqual(bundle.budget_tokens);
    expect(bundle.budget_tokens).toBe(DEFAULT_CONTEXT_BUDGET_TOKENS);
    expect(bundle.truncated).toBe(false);
    expect(bundle.provenance_ids).toEqual(bundle.items.map((i) => i.id));
    expect(approxTokenCount(bundle.items.map((i) => i.text).join("\n"))).toBeLessThanOrEqual(6000);
  });

  it("produces a readable, source-tagged item text", () => {
    const bundle = buildContextBundle(input);
    const chunk = bundle.items.find((i) => i.id === "pc_0001")!;
    expect(chunk.text).toContain("[policy] README (The five known fraud patterns > 1.)");
    const prior = bundle.items.find((i) => i.id === "CC-0200")!;
    expect(prior.text).toContain("[prior case] CC-0200 (cleared) — why similar: same pattern");
  });

  it("sets truncated and drops lowest-priority items on a tight budget", () => {
    const budget = 60;
    const bundle = buildContextBundle(input, budget);
    expect(bundle.truncated).toBe(true);
    expect(bundle.total_tokens).toBeLessThanOrEqual(budget);
    // Pattern block and evidence fit first; some lower-ranked items drop.
    expect(bundle.provenance_ids).toContain("pattern:card_testing");
    expect(bundle.items[bundle.items.length - 1]).toBeDefined();
  });

  it("includes a pattern block even for an undocumented/empty-list hypothesis", () => {
    const bundle = buildContextBundle({ ...input, patterns: [] });
    expect(bundle.items.every((i) => i.kind !== "pattern")).toBe(true);
  });
});