import { describe, expect, it } from "vitest";
import { buildEvidenceForTool, createEvidenceIdGen, regionLabel } from "../../agent/src/evidenceBuilder.js";

const AS_OF = "2016-07-22 19:52:55";
const community = (rate: number, population?: number, nCases?: number, size = 1186) =>
  buildEvidenceForTool(
    "get_community",
    {
      community_id: "comm_C00051-K1",
      size,
      stats: {
        confirmed_fraud_rate: rate,
        ...(nCases !== undefined ? { n_cases: nCases } : {}),
        ...(population !== undefined ? { population_confirmed_fraud_rate: population } : {}),
      },
    },
    createEvidenceIdGen(),
    AS_OF,
  )[0]!;

describe("community evidence", () => {
  it("does not vote fraud when the community resolves as fraud less often than cases do generally (CC-0955)", () => {
    const e = community(0.48, 0.84, 212);
    expect(e.supports).toEqual([]);
    expect(e.weight_hint).toBe(0.2);
    expect(e.summary).toContain("48% across 212 closed case(s)");
    expect(e.summary).toContain("not a fraud signal");
    // The population rate decides the vote but is not printed.
    expect(e.summary).not.toContain("84");
  });

  it("votes fraud when the community is enriched above the history", () => {
    const e = community(0.95, 0.84, 40);
    expect(e.supports).toEqual(["fraud"]);
    expect(e.weight_hint).toBe(0.45);
  });

  it("does not vote when the community is the card alone -- those are the card's own prior cases", () => {
    // Same fact as find_prior_cases; counting it here too made two R1 signals out of one.
    const e = community(1, 0.84, 2, 1);
    expect(e.supports).toEqual([]);
    expect(e.weight_hint).toBe(0.2);
    expect(e.summary).toContain("this card alone");
  });

  it("files no vote without a population figure to compare against", () => {
    expect(community(0.95).supports).toEqual([]);
  });
});

describe("regionLabel", () => {
  it("prints billing-region codes as integers", () => {
    expect(regionLabel("239.0")).toBe("239");
    expect(regionLabel("502")).toBe("502");
    expect(regionLabel(undefined)).toBe("");
  });
});
