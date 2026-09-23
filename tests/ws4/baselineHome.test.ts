import { describe, it, expect } from "vitest";
import {
  buildEvidenceForTool,
  computeBaselineHome,
  createEvidenceIdGen,
  type BaselineHome,
} from "../../agent/src/evidenceBuilder.js";
import { shiftAsOf } from "../../agent/src/investigation.js";

const AS_OF = "2016-11-12T00:35:00Z";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txn_id: "T1",
    ts: "2016-11-11T10:00:00Z",
    amount_usd: 40,
    product_cd: "W",
    channel: "in_person",
    risk_score: 0.1,
    addr1: "204",
    id_15: "",
    id_23: "",
    m_flags: "TTTTTTTTT",
    ...over,
  };
}

function build(
  rows: Record<string, unknown>[],
  baselineHome: BaselineHome | undefined,
  flaggedTxnId = "T1",
): ReturnType<typeof buildEvidenceForTool> {
  return buildEvidenceForTool(
    "get_transaction_history",
    { rows, stats: { count: rows.length, total_amount_usd: 0, window: "168h" }, baseline_home: baselineHome },
    createEvidenceIdGen(),
    AS_OF,
    undefined,
    flaggedTxnId,
  );
}

const HOME_204: BaselineHome = { regions: ["204"], count: 40, total: 45, days: 83 };

/** Items that speak about region: support or contradict out_of_region_use. */
function regionItems(items: ReturnType<typeof build>) {
  return items.filter(
    (i) =>
      (i.supports.includes("out_of_region_use") || i.contradicts.includes("out_of_region_use")) &&
      i.summary.includes("region"),
  );
}

describe("computeBaselineHome", () => {
  it("takes the most-used card-present region, ignoring online rows and rows without a region", () => {
    const home = computeBaselineHome(
      [
        { channel: "in_person", addr1: "204" },
        { channel: "in_person", addr1: "204" },
        { channel: "in_person", addr1: "330" },
        { channel: "online", addr1: "330" },
        { channel: "online", addr1: "330" },
        { channel: "in_person", addr1: "" },
        { channel: "in_person", addr1: null },
      ],
      83,
    );
    expect(home).toEqual({ regions: ["204"], count: 2, total: 3, days: 83 });
  });

  it("keeps every tied region as home, which only makes the away claim harder to trigger", () => {
    const home = computeBaselineHome(
      [
        { channel: "in_person", addr1: "330" },
        { channel: "in_person", addr1: "204" },
      ],
      83,
    );
    expect(home?.regions).toEqual(["204", "330"]);
  });

  it("returns undefined rather than inventing a home when there is no card-present history", () => {
    expect(computeBaselineHome([{ channel: "online", addr1: "204" }], 83)).toBeUndefined();
    expect(computeBaselineHome([], 83)).toBeUndefined();
  });
});

describe("shiftAsOf", () => {
  it("moves the tool-format timestamp back by whole hours, in UTC", () => {
    expect(shiftAsOf("2016-11-12 00:35:00", 168)).toBe("2016-11-05 00:35:00");
  });

  it("crosses month and day boundaries without a local-time offset", () => {
    expect(shiftAsOf("2016-08-01 03:00:00", 4)).toBe("2016-07-31 23:00:00");
  });

  it("accepts ISO input with a T separator and Z suffix", () => {
    expect(shiftAsOf("2016-11-12T00:35:00Z", 168)).toBe("2016-11-05 00:35:00");
  });
});

describe("region evidence against the pre-window home", () => {
  // CC-1665 (gold out_of_region_use) was called a takeover: the fraud burst
  // dominated the window, so the window's own mode read the fraudster's region
  // as home and the flagged charge looked like it was at home.
  it("keeps a window dominated by the away region from being read as home (CC-1665 shape)", () => {
    const rows = [
      row({ txn_id: "T1", addr1: "330", ts: "2016-11-11T20:00:00Z" }),
      row({ txn_id: "T2", addr1: "330", ts: "2016-11-11T21:00:00Z" }),
      row({ txn_id: "T3", addr1: "330", ts: "2016-11-11T22:00:00Z" }),
      row({ txn_id: "T4", addr1: "204", ts: "2016-11-09T10:00:00Z" }),
    ];
    const items = regionItems(build(rows, HOME_204));
    const away = items.find((i) => i.supports.includes("out_of_region_use"));
    expect(away).toBeDefined();
    expect(away?.summary).toContain("usual region 204");
    expect(away?.summary).toContain("alongside 1 at home");
    // Nothing may call 330 the card's usual region.
    expect(items.some((i) => i.contradicts.includes("out_of_region_use"))).toBe(false);
  });

  it("contradicts out_of_region_use when the flagged charge is in the pre-window home", () => {
    const rows = [
      row({ txn_id: "T1", addr1: "204" }),
      row({ txn_id: "T2", addr1: "330", ts: "2016-11-10T10:00:00Z" }),
    ];
    const items = regionItems(build(rows, HOME_204));
    const home = items.find((i) => i.contradicts.includes("out_of_region_use"));
    expect(home?.summary).toContain("the card's usual region before this window");
    expect(items.some((i) => i.supports.includes("out_of_region_use"))).toBe(false);
  });

  it("reads one away region sustained over days as a trip, not a clone", () => {
    const rows = [
      row({ txn_id: "T1", addr1: "330", ts: "2016-11-11T20:00:00Z" }),
      row({ txn_id: "T2", addr1: "330", ts: "2016-11-08T09:00:00Z" }),
    ];
    const items = regionItems(build(rows, HOME_204));
    const trip = items.find((i) => i.summary.includes("the shape of a trip"));
    expect(trip).toBeDefined();
    expect(trip?.contradicts).toContain("out_of_region_use");
    expect(trip?.supports).not.toContain("out_of_region_use");
  });
});

describe("identity match failures are routed by the pre-window home", () => {
  const mixed = (flaggedAddr: string) => [
    row({ txn_id: "T1", addr1: flaggedAddr, m_flags: "FFTTTTTTT" }),
    row({ txn_id: "T2", channel: "online", addr1: "", m_flags: "TTTTTTTTT" }),
  ];
  const matchItem = (items: ReturnType<typeof build>) =>
    items.find((i) => i.summary.includes("failing two or more identity match checks"));

  it("supports account_takeover alone when the flagged charge is at home", () => {
    expect(matchItem(build(mixed("204"), HOME_204))?.supports).toEqual(["account_takeover"]);
  });

  it("supports out_of_region_use alone when the flagged charge is away from home", () => {
    expect(matchItem(build(mixed("330"), HOME_204))?.supports).toEqual(["out_of_region_use"]);
  });

  it("stays neutral between the two when there is no pre-window home to compare with", () => {
    expect(matchItem(build(mixed("204"), undefined))?.supports).toEqual([
      "account_takeover",
      "out_of_region_use",
    ]);
  });
});
