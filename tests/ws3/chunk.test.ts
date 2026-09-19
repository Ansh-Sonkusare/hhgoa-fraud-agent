import { describe, expect, it } from "vitest";
import { chunkMarkdown, chunkProse } from "../../rag/src/chunk.js";
import { approxTokenCount } from "../../rag/src/tokenCount.js";

const R5_MARKDOWN = `# Fraud Policy

### Rules

**R5. Card testing.** Three or more small online authorizations on one card within an hour, followed by a larger purchase: recommend \`DECLINE_TRANSACTION\` and \`STEP_UP_AUTH\`. If a purchase over \\$100 has already cleared, recommend \`BLOCK_CARD\`.

### 4. Exposure

Exposure is the sum of the absolute amounts of every transaction the agent has identified as part of the fraud episode, including the flagged one. Report it in USD.`;

describe("chunkMarkdown", () => {
  it("splits by heading and keeps heading paths", () => {
    const chunks = chunkMarkdown(R5_MARKDOWN);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.heading_path).toBe("Fraud Policy > Rules");
    expect(chunks[1]!.heading_path).toBe("Fraud Policy > 4. Exposure");
    expect(chunks[0]!.text).toContain("R5. Card testing.");
  });

  it("keeps chunk sizes within the ~300-500 token target", () => {
    // A section whose body is many small paragraphs must be packed into
    // ~300-500 token chunks (PRD §11 target). Each paragraph below is well
    // under the target, so the *stack* is what gets split at the target.
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ` + "word ".repeat(20));
    const md = `### Section big\n\n${paras.join("\n\n")}`;
    const chunks = chunkMarkdown(md);
    const packed = chunks.filter((c) => c.heading_path.startsWith("Section big"));
    expect(packed.length).toBeGreaterThan(1);
    for (const c of packed) {
      expect(approxTokenCount(c.text)).toBeLessThanOrEqual(500);
    }
    // A single paragraph larger than the target is left intact (can't split
    // a sentence-body), but the stacked case above must be split.
    const hugemd = "### Section huge\n\n" + "word ".repeat(2000);
    const huge = chunkMarkdown(hugemd);
    expect(huge.length).toBe(1);
  });

  it("aggregates small adjacent sections into distinct chunk ids", () => {
    const chunks = chunkMarkdown("### A. one\n\nintro text here\n\n### B. two\n\nmore words here");
    expect(chunks.length).toBe(2);
  });

  it("handles nested headings h1-h4", () => {
    const chunks = chunkMarkdown("# L1\n\n## L2\n\n### L3\n\n#### L4\n\nbody");
    expect(chunks[0]!.heading_path).toBe("L1 > L2 > L3 > L4");
  });

  it("returns [] for empty or heading-only input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("# Just a heading\n\n# Another")).toEqual([]);
  });
});

describe("chunkProse", () => {
  it("packs paragraphs up to the target size", () => {
    const paras = Array.from({ length: 20 }, (_, i) => "paragraph ".repeat(40) + i);
    const chunks = chunkProse(paras.join("\n\n"), "Flat prose");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.heading_path).toBe("Flat prose");
      expect(approxTokenCount(c.text)).toBeLessThanOrEqual(501);
    }
  });
});