import { describe, it, expect } from "vitest";
import { FixtureRunSource } from "../../api/src/runSource.js";

describe("FixtureRunSource (WS6)", () => {
  it("loads both fixtures, schema-validated, keyed by case_id", () => {
    const source = new FixtureRunSource();
    const ids = source.listKnownCaseIds().sort();
    expect(ids).toEqual(["HHG-910", "HHG-920"]);
  });

  it("returns null for an unknown case id", () => {
    const source = new FixtureRunSource();
    expect(source.getRecording("HHG-001")).toBeNull();
  });

  it("HHG-910 (clear fraud) recording has monotonically increasing seq and a fraud verdict", () => {
    const source = new FixtureRunSource();
    const recording = source.getRecording("HHG-910");
    expect(recording).not.toBeNull();
    const seqs = recording!.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(recording!.answer.case.verdict).toBe("fraud");
    expect(recording!.events.at(-1)?.type).toBe("done");
  });

  it("HHG-920 (ambiguous) recording shows an evidence_requested event before the second assessment", () => {
    const source = new FixtureRunSource();
    const recording = source.getRecording("HHG-920");
    const types = recording!.events.map((e) => e.type);
    expect(types).toContain("evidence_requested");
    expect(types.filter((t) => t === "assessment_updated")).toHaveLength(2);
  });
});
