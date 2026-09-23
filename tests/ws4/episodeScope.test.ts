import { describe, it, expect } from "vitest";
import type { TransactionHistoryRow } from "../../contracts/src/index.js";
import { scopeEpisode } from "../../agent/src/investigation.js";

const row = (txn_id: string, ts: string, amount_usd: number, risk_score: number, channel = "online", product_cd = "C"): TransactionHistoryRow =>
  ({ txn_id, ts, amount_usd, risk_score, channel, product_cd }) as TransactionHistoryRow;

const flagged = row("F", "2016-11-12 10:00:00", 120, 0.6);
const ids = (rows: TransactionHistoryRow[]): string[] => rows.map((r) => r.txn_id).sort();

describe("scopeEpisode", () => {
  // Shapes measured on held-out closed cases (agent/src/episodeModel.ts): an
  // out-of-region episode stays in the flagged charge's foreign billing region.
  const inPerson = (id: string, ts: string, amt: number, risk: number, addr1: string, m_flags: string) =>
    ({ ...row(id, ts, amt, risk, "in_person", "W"), addr1, id_15: "", m_flags }) as TransactionHistoryRow;
  const oorFlagged = inPerson("F", "2016-08-05 19:32:50", 58.98, 0.48, "272.0", "TFFM1FFFFF");
  const oorRows = [
    inPerson("homeBefore", "2016-08-04 12:00:00", 33.94, 0.18, "191.0", "M0FT"),
    inPerson("homeBefore2", "2016-08-04 18:20:19", 56.57, 0.02, "204.0", "TTTM0TT"),
    oorFlagged,
    inPerson("sameRegion", "2016-08-05 19:48:23", 38.99, 0.36, "272.0", "TFFM1FFFFF"),
    inPerson("homeAfter", "2016-08-05 21:50:46", 39.03, 0.12, "204.0", "M0FF"),
    inPerson("homeRiskyAfter", "2016-08-06 15:28:10", 58.04, 0.31, "204.0", "TTTT"),
  ];

  it("keeps the flagged charge's foreign-region charges and leaves the card's home spending out", () => {
    expect(ids(scopeEpisode(oorRows, oorFlagged, "default"))).toEqual(["F", "sameRegion"]);
  });

  it("never reaches back more than 2h before the flagged charge", () => {
    const early = inPerson("sameRegion3hBefore", "2016-08-05 16:30:00", 58.98, 0.9, "272.0", "TFFM1FFFFF");
    expect(ids(scopeEpisode([early, ...oorRows], oorFlagged, "default"))).not.toContain("sameRegion3hBefore");
  });

  it("keeps low-scoring card-testing probes under $5 (R5)", () => {
    const rows = [row("probe", "2016-11-12 09:40:00", 1.5, 0.2), flagged];
    expect(ids(scopeEpisode(rows, flagged, "default"))).toEqual(["F", "probe"]);
  });

  it("scopes undocumented activity by channel and product code, not risk", () => {
    const rows = [
      flagged,
      row("sameProdLowRisk", "2016-11-12 10:20:00", 480, 0.15),
      row("otherProd", "2016-11-12 10:25:00", 90, 0.8, "online", "R"),
    ];
    expect(ids(scopeEpisode(rows, flagged, "undocumented"))).toEqual(["F", "sameProdLowRisk"]);
  });
});
