import { describe, it, expect } from "vitest";
import type { TransactionHistoryRow } from "../../contracts/src/index.js";
import { scopeEpisode } from "../../agent/src/investigation.js";

const row = (txn_id: string, ts: string, amount_usd: number, risk_score: number, channel = "online", product_cd = "C"): TransactionHistoryRow =>
  ({ txn_id, ts, amount_usd, risk_score, channel, product_cd }) as TransactionHistoryRow;

const flagged = row("F", "2016-11-12 10:00:00", 120, 0.6);
const ids = (rows: TransactionHistoryRow[]): string[] => rows.map((r) => r.txn_id).sort();

describe("scopeEpisode", () => {
  it("keeps same-channel risky charges from 2h before the flagged one to as_of", () => {
    const rows = [
      row("before3h", "2016-11-12 06:59:00", 80, 0.7),
      row("before1h", "2016-11-12 09:00:00", 80, 0.7),
      flagged,
      row("after2d", "2016-11-14 09:00:00", 300, 0.4),
    ];
    expect(ids(scopeEpisode(rows, flagged, "default"))).toEqual(["F", "after2d", "before1h"]);
  });

  it("leaves out ordinary low-risk spending and other channels", () => {
    const rows = [
      flagged,
      row("lowRisk", "2016-11-12 11:00:00", 60, 0.1),
      row("inPerson", "2016-11-12 11:30:00", 500, 0.9, "in_person", "W"),
    ];
    expect(ids(scopeEpisode(rows, flagged, "default"))).toEqual(["F"]);
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
