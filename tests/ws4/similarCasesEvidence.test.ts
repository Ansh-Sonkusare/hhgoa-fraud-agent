import { describe, expect, it } from "vitest";
import { buildEvidenceForTool, createEvidenceIdGen } from "../../agent/src/evidenceBuilder.js";

const AS_OF = "2016-08-04 15:22:38";

function build(cases: Array<{ case_id: string; score: number; outcome: string }>) {
  return buildEvidenceForTool(
    "retrieve_similar_cases",
    { cases: cases.map((c) => ({ ...c, overlap_reason: "shared Card" })) },
    createEvidenceIdGen(),
    AS_OF,
  );
}

function at<T>(items: T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`expected an evidence item at index ${i}`);
  return item;
}

describe("similar-case precedents", () => {
  it("weights a precedent by its similarity, the same way for either outcome", () => {
    const items = build([
      { case_id: "CC-0282", score: 0.3, outcome: "confirmed_fraud" },
      { case_id: "CC-0785", score: 0.3, outcome: "cleared" },
    ]);
    const fraud = at(items, 0);
    const cleared = at(items, 1);
    expect(fraud.weight_hint).toBe(0.15);
    expect(cleared.weight_hint).toBe(0.15);
  });

  it("lets a cleared precedent argue for legitimate, not only against fraud", () => {
    const cleared = at(build([{ case_id: "CC-0785", score: 0.3, outcome: "cleared" }]), 0);
    expect(cleared.supports).toEqual(["legitimate"]);
    expect(cleared.contradicts).toEqual(["fraud"]);
  });

  it("caps the weight so one close precedent cannot decide a case", () => {
    const item = at(build([{ case_id: "CC-0001", score: 1, outcome: "confirmed_fraud" }]), 0);
    expect(item.weight_hint).toBe(0.5);
  });

  it("drops amount-band-only matches, which are filler rather than memory", () => {
    const items = build([
      { case_id: "CC-0282", score: 0.3, outcome: "cleared" },
      { case_id: "CC-0001", score: 0.03, outcome: "cleared" },
      { case_id: "CC-0002", score: 0.03, outcome: "confirmed_fraud" },
    ]);
    expect(items.map((i) => i.entities[0]?.id)).toEqual(["CC-0282"]);
  });

  it("emits nothing when every candidate is filler", () => {
    expect(build([{ case_id: "CC-0001", score: 0.03, outcome: "cleared" }])).toEqual([]);
  });
});
