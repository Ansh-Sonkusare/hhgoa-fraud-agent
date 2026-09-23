import { describe, it, expect } from "vitest";
import {
  buildEvidenceForTool,
  createEvidenceIdGen,
  isNonDiscriminatingDetector,
} from "../../agent/src/evidenceBuilder.js";
import { independentFraudSignals } from "../../agent/src/singleSignal.js";
import { assessSharedOrigin } from "../../agent/src/sharedOrigin.js";
import { createFacts } from "../../agent/src/investigation.js";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";

// Fixes from the 50-case gap analysis (docs/logs.md, "Gap analysis"): an
// amount baseline needs enough history, a card's own fraud is not another
// card's, prior cases name every pattern they carried, and detector tiers
// that fire as often on cleared alerts as on fraud are not a fraud signal.

const AS_OF = "2016-08-04T00:00:00Z";
const build = (tool: string, data: unknown) => buildEvidenceForTool(tool, data, createEvidenceIdGen(), AS_OF);

describe("baseline deviation needs enough prior transactions", () => {
  it("claims no deviation from a two-transaction history (CC-0589: z=1110)", () => {
    const [item] = build("get_baseline_deviation", { amount_z: 1110.6, geo_z: 0, device_z: 1, time_z: 0, n_prior: 2 });
    expect(item!.summary).toContain("only 2 prior transaction(s)");
    expect(item!.supports).toEqual([]);
    expect(item!.contradicts).toEqual([]);
  });

  it("still reads a real deviation on a card with history", () => {
    const [item] = build("get_baseline_deviation", { amount_z: 3.1, geo_z: 0, device_z: 0, time_z: 0, n_prior: 40 });
    expect(item!.supports).toEqual(["fraud"]);
  });
});

describe("prior cases", () => {
  it("support every pattern the cited fraud carried and say whose fraud it was", () => {
    const [item] = build("find_prior_cases", {
      cases: [
        { case_id: "CC-1800", outcome: "confirmed_fraud", pattern: "account_takeover", own: true },
        { case_id: "CC-2031", outcome: "confirmed_fraud", pattern: "card_not_present_fraud", own: true },
        { case_id: "CC-2133", outcome: "confirmed_fraud", pattern: "card_not_present_fraud", own: true },
      ],
    });
    expect(item!.supports).toEqual(["account_takeover", "card_not_present_fraud"]);
    expect(item!.summary).toContain("Prior confirmed fraud case(s) on this card or customer");
  });

  it("the card's own earlier fraud does not corroborate a shared origin; another card's does", () => {
    const f = createFacts("HHG-GAP-1", AS_OF, { kind: "risk_score", risk_score: 0.8 });
    f.primary_card = { type: "Card", id: "C04248-K2" };
    f.rings = [{ shared_type: "device", shared_id: "D1", card_ids: ["C04248-K2", "C09999-K1"], community_id: "" }];
    f.prior_cases = [{ case_id: "CC-0055", outcome: "confirmed_fraud", pattern: "card_not_present_new_device", own: true } as never];
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(false);
    f.prior_cases = [{ case_id: "CC-0056", outcome: "confirmed_fraud", pattern: "card_testing", own: false } as never];
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(true);
  });
});

describe("detector tiers that do not separate fraud from cleared alerts", () => {
  const det = (pattern: string, score: number): EvidenceItem =>
    build("detect_patterns", { patterns: [{ pattern_id: pattern, score, evidence: ["T1"] }] })[0]!;

  it("are recognised by tier", () => {
    expect(isNonDiscriminatingDetector(det("card_not_present_new_device", 0.65))).toBe(true);
    expect(isNonDiscriminatingDetector(det("card_not_present_fraud", 0.4))).toBe(true);
    expect(isNonDiscriminatingDetector(det("account_takeover", 0.8))).toBe(false);
    expect(isNonDiscriminatingDetector(det("card_not_present_fraud", 0.8))).toBe(false);
  });

  it("keep their pattern support but do not count as an independent fraud signal", () => {
    const low = det("card_not_present_new_device", 0.65);
    expect(low.supports).toEqual(["card_not_present_new_device"]);
    expect(independentFraudSignals([low])).toEqual([]);
    expect(independentFraudSignals([det("account_takeover", 0.8)])).toEqual(["policy_match"]);
  });
});
