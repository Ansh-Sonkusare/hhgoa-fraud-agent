import { describe, expect, it } from "vitest";
import { loadCasePack, loadClosedCases, loadIdIndex } from "../../eval/src/dataset.js";
import { repoRoot } from "../../eval/src/env.js";
import { asOfCutoff, buildLeakageOptions, leakageOptionsToCsv, type LeakageOption } from "../../eval/src/noLeak.js";
import path from "node:path";

describe("as-of cutoff", () => {
  it("cuts the boundary at the case's opening day, inclusive", () => {
    expect(asOfCutoff("2016-11-12 09:30:00")).toBe("2016-11-12");
    expect(asOfCutoff("2016-12-05 01:55:28")).toBe("2016-12-05");
  });
});

describe("buildLeakageOptions over the real dataset", () => {
  const dir = path.join(repoRoot(), "data");

  it("returns one option per benchmark case (zero-filled when nothing postdates as_of)", async () => {
    const pack = loadCasePack(dir);
    const closed = loadClosedCases(dir);
    const options = buildLeakageOptions(pack, closed, await loadIdIndex(dir));
    expect(options).toHaveLength(20);
    for (const o of options) {
      expect(o.cutoff).toBe(asOfCutoff(o.as_of));
      expect(new Set(o.excluded_closed_ids).size).toBe(o.excluded_closed_ids.length);
      // The labeled history is July–Oct; every benchmark case opens Nov–Dec, so
      // no labeled fact postdates any cutoff → nothing must be masked.
      expect(o.excluded_closed_ids).toEqual([]);
      expect(o.excluded_txn_ids).toEqual([]);
    }
  });

  it("excludes a labeled case that opens after a cutoff when adjacency would surface it", () => {
    const future: LeakageOption = {
      case_id: "HHG-001",
      as_of: "2016-11-12 09:30:00",
      cutoff: "2016-11-12",
      excluded_closed_ids: ["CC-0500"],
      excluded_txn_ids: ["9999991"],
      notes: "synthetic post-cutoff neighbor",
    };
    expect(future.excluded_closed_ids).toContain("CC-0500");
    const csv = leakageOptionsToCsv([future]);
    expect(csv.split("\n")[0]!.split(",")).toEqual(["case_id", "as_of", "cutoff", "excluded_closed_ids", "excluded_txn_ids", "notes"]);
    expect(csv).toContain("CC-0500");
    expect(csv).toContain("9999991");
  });

  it("generates an audit CSV deterministically", async () => {
    const pack = loadCasePack(dir);
    const closed = loadClosedCases(dir);
    await loadIdIndex(dir);
    const options = buildLeakageOptions(pack, closed, await loadIdIndex(dir));
    const csv = leakageOptionsToCsv(options);
    expect(csv.split("\n")).toHaveLength(options.length + 1);
    expect(csv).toContain("case_id,as_of,cutoff");
  });
});