import { describe, it, expect } from "vitest";
import { CASE_PACK, findCasePackEntry } from "../../api/src/data/casePack.js";

describe("CASE_PACK (WS6 case queue source data)", () => {
  it("has exactly the 20 benchmark cases, HHG-001..HHG-020, no duplicates", () => {
    expect(CASE_PACK).toHaveLength(20);
    const ids = CASE_PACK.map((c) => c.case_id);
    expect(new Set(ids).size).toBe(20);
    for (let i = 1; i <= 20; i++) {
      const id = `HHG-${String(i).padStart(3, "0")}`;
      expect(ids).toContain(id);
    }
  });

  it("risk_score is null iff trigger_type is not risk_score", () => {
    for (const entry of CASE_PACK) {
      if (entry.trigger_type === "risk_score") {
        expect(entry.risk_score).not.toBeNull();
      } else {
        expect(entry.risk_score).toBeNull();
      }
    }
  });

  it("findCasePackEntry resolves a known id and returns undefined for an unknown one", () => {
    expect(findCasePackEntry("HHG-010")?.card_id).toBe("C10434-K1");
    expect(findCasePackEntry("HHG-999")).toBeUndefined();
  });
});
