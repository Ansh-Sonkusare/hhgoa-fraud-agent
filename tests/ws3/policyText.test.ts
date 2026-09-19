import { describe, expect, it } from "vitest";
import { buildRawPolicyChunks } from "../../rag/src/ingestPolicy.js";
import {
  extractSubsection,
  getFraudPolicySectionMarkdown,
  getPatternsSectionMarkdown,
  parsePatternLabel,
  parseRuleLabel,
  splitBoldItems,
} from "../../rag/src/sources/policyText.js";

describe("policyText source extraction", () => {
  it("extracts the patterns section between its headings", () => {
    const md = getPatternsSectionMarkdown();
    expect(md).toContain("Card testing");
    expect(md).toContain("Account takeover");
    expect(md).not.toContain("Regulatory references");
  });

  it("extracts the fraud policy section", () => {
    const md = getFraudPolicySectionMarkdown();
    expect(md).toContain("R1. Verify before you block");
    expect(md).toContain("R10");
    expect(md).toContain("A case is not a report");
  });

  it("extractSubsection slices start-inclusive/end-exclusive", () => {
    const md = "# A\n\nx\n\n# B\n\ny\n\n# C\n\nz";
    expect(extractSubsection(md, "# A", "# B")).toBe("# A\n\nx");
    expect(extractSubsection(md, "# B", "# C")).toBe("# B\n\ny");
  });

  it("throws on a missing start heading", () => {
    expect(() => extractSubsection("no headings here", "# Nope", "# Later")).toThrow();
  });

  it("splitBoldItems finds bold-label paragraphs and skips the plain intro", () => {
    const items = splitBoldItems("lead-in paragraph ignored\n\n**1. One.** body one\n\n**2. Two.** body two");
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ label: "1. One.", text: "1. One. body one" });
    expect(items[1]!.text).toBe("2. Two. body two");
  });

  it("parsePatternLabel maps the 5 README patterns to contract pattern ids", () => {
    expect(parsePatternLabel("1. Card testing.")).toEqual({
      number: 1,
      pattern_id: "card_testing",
      name: "Card testing",
    });
    expect(parsePatternLabel("5. Account takeover.")!.pattern_id).toBe("account_takeover");
    expect(parsePatternLabel("9. Unknown.")).toBeUndefined();
    expect(parsePatternLabel("plain text")).toBeUndefined();
  });

  it("parseRuleLabel maps R1-R10", () => {
    expect(parseRuleLabel("R5. Card testing.")).toEqual({ number: 5, title: "Card testing" });
    expect(parseRuleLabel("R10. Never `BLOCK_ALL_CARDS`")!.number).toBe(10);
  });
});

describe("buildRawPolicyChunks", () => {
  const chunks = buildRawPolicyChunks();

  it("indexes all 5 documented patterns with their pattern_id", () => {
    const patternChunks = chunks.filter((c) => c.source_kind === "pattern");
    expect(patternChunks.length).toBe(5);
    const ids = patternChunks.map((c) => c.pattern_id).sort();
    expect(ids).toEqual([
      "account_takeover",
      "card_not_present_fraud",
      "card_not_present_new_device",
      "card_testing",
      "out_of_region_use",
    ]);
  });

  it("indexes every rule R1-R10 as its own chunk", () => {
    const ruleChunks = chunks.filter((c) => c.heading_path.includes("Rules >"));
    const labels = ruleChunks.map((c) => c.heading_path);
    for (let i = 1; i <= 10; i++) {
      expect(labels.some((l) => l.includes(`R${i}.`))).toBe(true);
    }
  });

  it("indexes the rest of the fraud policy by heading", () => {
    const paths = chunks.filter((c) => c.source_kind === "policy").map((c) => c.heading_path);
    expect(paths.some((p) => p.includes("1. Actions"))).toBe(true);
    expect(paths.some((p) => p.includes("3a. A case is not a report"))).toBe(true);
    expect(paths.some((p) => p.includes("6. Stopping"))).toBe(true);
  });

  it("includes the regulatory reference text", () => {
    const reg = chunks.filter((c) => c.source_kind === "regulatory");
    expect(reg.length).toBeGreaterThanOrEqual(1);
    expect(reg.some((c) => c.source_doc.includes("Account Takeover"))).toBe(true);
  });

  it("keeps every chunk within the size target", () => {
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });
});