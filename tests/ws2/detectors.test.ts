import { describe, expect, it } from "vitest";
import { KNOWN, runQuery } from "./helpers.js";

/**
 * The five documented patterns are all implemented inside `detect_patterns`,
 * which is what backs the `detect_patterns` contract tool.
 *
 * This file used to also exercise five standalone `det_*` queries through
 * `describe.each`, asserting only that each returned a score in [0,1] and an
 * array. Those queries were deleted: nothing invoked them, and they had drifted
 * from the thresholds in docs/DATASET_README.md, so they were duplicated dead
 * code presenting itself as the reference implementation. Rather than drop the
 * coverage, the checks below pin the score ladder each detector may emit, which
 * is a stronger assertion than the old range check — a detector whose threshold
 * drifts now shows up here as an undocumented number.
 */
const SCORE_TIERS: Record<string, number[]> = {
  // R5: three or more authorizations under $5 within an hour. 0.9 once a larger
  // purchase has followed them, 0.55 while the run has no larger purchase yet.
  card_testing: [0.55, 0.9],
  // Pattern 2: a burst of two to four within 48 hours; 0.8 with an amount
  // outlier against the card's own prior mean.
  card_not_present_fraud: [0.4, 0.8],
  // Pattern 3: as above with the identity record marking the device New; 0.85
  // when also behind a proxy.
  card_not_present_new_device: [0.65, 0.85],
  // Pattern 4, graded by shape rather than volume: 0.8 for two or more distinct
  // new regions (which cannot be one trip), 0.65 for a single new region over a
  // short span, 0.3 when a single new region runs for days — DATASET_README
  // calls that "a trip, not a clone".
  out_of_region_use: [0.3, 0.65, 0.8],
  // Pattern 5: mixed-channel activity with match-flag failures measured against
  // the card's own prior-window baseline.
  account_takeover: [0.45, 0.8],
};

interface DetectPatternsResult {
  scores: Record<string, number>;
  evidence: Record<string, string[]>;
}

const onKnownCard = (): Promise<DetectPatternsResult> =>
  runQuery<DetectPatternsResult>("detect_patterns", {
    card_id: KNOWN.txnCardId,
    as_of: KNOWN.lateAsOf,
  });

describe("detect_patterns", () => {
  it("returns scores/evidence maps keyed by pattern_id, only for patterns that fired", async () => {
    const r = await onKnownCard();
    for (const [patternId, score] of Object.entries(r.scores)) {
      expect(score).toBeGreaterThan(0);
      expect(r.evidence[patternId]).toBeDefined();
    }
  });

  it("returns no patterns for a card with no history as of a very early as_of", async () => {
    const r = await runQuery<DetectPatternsResult>("detect_patterns", {
      card_id: KNOWN.txnCardId,
      as_of: "2015-01-01 00:00:00",
    });
    expect(Object.keys(r.scores).length).toBe(0);
  });

  it("only ever emits one of the five documented pattern ids", async () => {
    const r = await onKnownCard();
    for (const patternId of Object.keys(r.scores)) {
      expect(Object.keys(SCORE_TIERS)).toContain(patternId);
    }
  });

  it("every score it emits is one of that pattern's documented tiers", async () => {
    const r = await onKnownCard();
    for (const [patternId, score] of Object.entries(r.scores)) {
      const tiers = SCORE_TIERS[patternId];
      expect(tiers, `undocumented pattern ${patternId}`).toBeDefined();
      // The scores are fixed tiers rather than computed values, so an exact
      // match is the right assertion here.
      expect(tiers, `${patternId} scored ${score}`).toContain(score);
    }
  });

  it("cites at least one transaction for every pattern that fired", async () => {
    const r = await onKnownCard();
    for (const patternId of Object.keys(r.scores)) {
      expect(Array.isArray(r.evidence[patternId])).toBe(true);
      expect(r.evidence[patternId]!.length).toBeGreaterThan(0);
    }
  });
});
