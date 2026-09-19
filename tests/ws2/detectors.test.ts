import { describe, expect, it } from "vitest";
import { KNOWN, runQuery } from "./helpers.js";

const DETECTORS = [
  "det_card_testing",
  "det_cnp_fraud",
  "det_cnp_new_device",
  "det_out_of_region",
  "det_account_takeover",
] as const;

describe("detect_patterns (aggregator)", () => {
  it("returns scores/evidence maps keyed by pattern_id, only for patterns that fired", async () => {
    const r = await runQuery<{ scores: Record<string, number>; evidence: Record<string, string[]> }>(
      "detect_patterns",
      { card_id: KNOWN.txnCardId, as_of: KNOWN.lateAsOf },
    );
    for (const [patternId, score] of Object.entries(r.scores)) {
      expect(score).toBeGreaterThan(0);
      expect(r.evidence[patternId]).toBeDefined();
    }
  });

  it("returns no patterns for a card with no history as of a very early as_of", async () => {
    const r = await runQuery<{ scores: Record<string, number> }>("detect_patterns", {
      card_id: KNOWN.txnCardId,
      as_of: "2015-01-01 00:00:00",
    });
    expect(Object.keys(r.scores).length).toBe(0);
  });
});

describe.each(DETECTORS)("%s", (name) => {
  it("returns a score in [0,1] and an evidence_rows array for a real card", async () => {
    const r = await runQuery<{ score: number; evidence_rows: string[] }>(name, {
      card_id: KNOWN.txnCardId,
      as_of: KNOWN.lateAsOf,
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(Array.isArray(r.evidence_rows)).toBe(true);
  });

  it("scores 0 for a card with no history as of a very early as_of", async () => {
    const r = await runQuery<{ score: number }>(name, {
      card_id: KNOWN.txnCardId,
      as_of: "2015-01-01 00:00:00",
    });
    expect(r.score).toBe(0);
  });
});
