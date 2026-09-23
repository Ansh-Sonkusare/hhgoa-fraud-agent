import { describe, it, expect } from "vitest";
import { buildEvidenceForTool, createEvidenceIdGen } from "../../agent/src/evidenceBuilder.js";

const AS_OF = "2016-11-12T00:35:00Z";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    txn_id: "T1",
    ts: "2016-11-11T10:00:00Z",
    amount_usd: 40,
    product_cd: "W",
    channel: "online",
    risk_score: 0.1,
    addr1: "204",
    id_15: "Found",
    id_23: "",
    m_flags: "TTTTTTTTT",
    ...over,
  };
}

function build(
  rows: Record<string, unknown>[],
  flaggedTxnId = "T1",
): ReturnType<typeof buildEvidenceForTool> {
  return buildEvidenceForTool(
    "get_transaction_history",
    { rows, stats: { count: rows.length, total_amount_usd: 0, window: "168h" } },
    createEvidenceIdGen(),
    AS_OF,
    undefined,
    flaggedTxnId,
  );
}

describe("discriminating transaction evidence", () => {
  it("names card_not_present_new_device when the FLAGGED transaction's device is new", () => {
    const items = build([row({ txn_id: "T1", id_15: "New" }), row({ txn_id: "T2" })]);
    const dev = items.find((i) => i.summary.includes("has not been seen on before"));
    expect(dev).toBeDefined();
    expect(dev?.supports).toContain("card_not_present_new_device");
    expect(dev?.entities.map((e) => e.id)).toEqual(["T1"]);
  });

  // The old rule fired whenever *any* transaction in the window was on a new
  // device and voted it as fraud support (precision 0.21; it fired on 87% of
  // cleared cases). The episode-level claim is now a pattern-shape item only
  // -- it names the new-device pattern *if* this is fraud, never counts as a
  // fraud signal -- and only when the flagged charge is itself online.
  it("leans away from new-device, without ruling it out, when only other online charges are on a new device", () => {
    // Held-out closed cases with this shape were card_not_present_fraud 69
    // times and card_not_present_new_device 23 times: a lean, not a rule-out,
    // and never a vote for the new-device pattern.
    const items = build([row({ txn_id: "T1", id_15: "Found" }), row({ txn_id: "T2", id_15: "New", ts: "2016-11-11T13:00:00Z" })]);
    const dev = items.find((i) => i.summary.includes("other online transaction(s) in the window"));
    expect(dev).toBeDefined();
    expect(dev?.summary.startsWith("Pattern shape: ")).toBe(true);
    expect(dev?.supports).toEqual([]);
    expect(dev?.contradicts).toEqual(["card_not_present_new_device"]);
    expect(dev?.weight_hint).toBeLessThan(0.45);
    expect(dev?.summary).toContain("without ruling it out");
    expect(dev?.entities.map((e) => e.id)).toEqual(["T1", "T2"]);
    expect(items.find((i) => i.summary.includes("so not the new-device pattern"))).toBeUndefined();
  });

  it("names the new-device pattern when a New-device charge is within 30 minutes of a known-device flagged one", () => {
    // Held-out: within 30 minutes, 38/96 new-device vs 8/227 plain CNP cases of this shape.
    const items = build([row({ txn_id: "T1", id_15: "Found" }), row({ txn_id: "T2", id_15: "New", ts: "2016-11-11T10:20:00Z" })]);
    const dev = items.find((i) => i.summary.includes("within 30 minutes of it"));
    expect(dev).toBeDefined();
    expect(dev?.summary.startsWith("Pattern shape: ")).toBe(true);
    expect(dev?.supports).toEqual(["card_not_present_new_device"]);
    expect(dev?.contradicts).toEqual(["card_not_present_fraud"]);
    expect(dev?.entities.map((e) => e.id)).toEqual(["T1", "T2"]);
    expect(items.find((i) => i.summary.includes("other online transaction(s) in the window"))).toBeUndefined();
  });

  it("does not name it when the flagged charge is card-present", () => {
    const items = build([row({ txn_id: "T1", id_15: "Found", channel: "in_person" }), row({ txn_id: "T2", id_15: "New" })]);
    expect(items.find((i) => i.summary.includes("other online transaction(s) in the window"))).toBeUndefined();
  });

  it("reads a flagged charge on a device the account already used as ruling out new-device only", () => {
    // A known device rules out the new-device pattern and nothing else. It is
    // not a vote for the cardholder: an attacker already inside the account
    // (account_takeover) and stolen-credential CNP fraud both run on known
    // devices. An earlier encoding read it as supports ["legitimate"] at 0.45
    // and on CC-5475 (account_takeover detected at 0.80, seven shared device
    // profiles) it was the only legitimate-leaning item in a 114-item brief
    // and the case still closed legitimate at 0.35. Rules out; supports nothing.
    const items = build([row({ txn_id: "T1", id_15: "Found" })]);
    const known = items.find((i) => i.summary.includes("already associated with this account"));
    expect(known).toBeDefined();
    expect(known?.supports).toEqual([]);
    expect(known?.contradicts).toContain("card_not_present_new_device");
  });

  it("says nothing about the device when id_15 is Unknown", () => {
    // "Unknown" is not "seen before"; only "Found" is.
    const items = build([row({ txn_id: "T1", id_15: "Unknown" })]);
    expect(items.find((i) => i.summary.includes("already associated with this account"))).toBeUndefined();
  });

  // Measured over all 5,565 closed cases: a cleared alert's flagged online
  // charge is on a New device 98% of the time and behind a proxy 7%, against
  // 74% / 5% for card_not_present_new_device. So a new device (proxied or
  // not) identifies *which* CNP pattern a fraud would be, but is not itself
  // evidence the charge was unauthorised -- it must not carry a standalone
  // fraud-strength weight, and the proxy must not raise it.
  it("names the new-device pattern without treating a new device or proxy as standalone proof", () => {
    const plain = build([row({ id_15: "New" })]).find((i) =>
      i.summary.includes("has not been seen on before"),
    );
    const proxied = build([row({ id_15: "New", id_23: "anonymous" })]).find((i) =>
      i.summary.includes("has not been seen on before"),
    );
    expect(plain?.supports).toEqual(["card_not_present_new_device"]);
    expect(plain?.contradicts).toEqual(["card_not_present_fraud"]);
    expect(plain?.weight_hint).toBeLessThanOrEqual(0.5);
    expect(proxied?.weight_hint).toBe(plain?.weight_hint);
    expect(proxied?.summary).toContain("proxy");
    expect(plain?.summary).toContain("if this is fraud");
  });

  it("names out_of_region_use for card-present spend away from the dominant region", () => {
    const items = build([
      row({ txn_id: "H1", channel: "in_person", addr1: "204" }),
      row({ txn_id: "H2", channel: "in_person", addr1: "204" }),
      row({ txn_id: "A1", channel: "in_person", addr1: "330" }),
    ]);
    const region = items.find((i) => i.summary.includes("billing regions"));
    expect(region).toBeDefined();
    // Only the away transaction is cited; home activity is context, not evidence.
    expect(region?.entities.map((e) => e.id)).toEqual(["A1"]);
    expect(region?.summary).toContain("330");
  });

  it("stays silent on region when all card-present spend is in one region", () => {
    const items = build([
      row({ txn_id: "H1", channel: "in_person" }),
      row({ txn_id: "H2", channel: "in_person" }),
    ]);
    expect(items.some((i) => i.summary.includes("billing regions"))).toBe(false);
  });

  it("names account_takeover only when mixed channels meet failed identity checks", () => {
    const mixed = build([
      row({ txn_id: "O1", channel: "online", m_flags: "FFTTTTTTT" }),
      row({ txn_id: "P1", channel: "in_person" }),
    ]);
    expect(mixed.some((i) => i.supports.includes("account_takeover"))).toBe(true);

    // Same failed checks but a single channel is not takeover-shaped.
    const oneChannel = build([
      row({ txn_id: "O1", channel: "online", m_flags: "FFTTTTTTT" }),
      row({ txn_id: "O2", channel: "online" }),
    ]);
    expect(oneChannel.some((i) => i.supports.includes("account_takeover"))).toBe(false);
  });

  it("emits nothing extra when the backend omits the discriminating fields", () => {
    const bare = build([
      { txn_id: "T1", ts: AS_OF, amount_usd: 10, product_cd: "W", channel: "online", risk_score: 0.1 },
    ]);
    // id_15, addr1 and the identity match flags are all absent, so nothing that
    // depends on them may be claimed.
    for (const summary of ["has not been seen on before", "billing regions", "identity match checks"]) {
      expect(bare.some((i) => i.summary.includes(summary))).toBe(false);
    }
    // `channel` is present, though, and it is enough on its own to rule the
    // card-present patterns out -- an online charge is by definition one where
    // the physical card was never presented.
    const structural = bare.find((i) => i.summary.includes("card-not-present (online)"));
    expect(structural).toBeDefined();
    expect(structural?.contradicts).toContain("out_of_region_use");
    // account_takeover is card-present in 93% of closed cases, so an online
    // flagged charge rules it out too; the card-level detector cannot see the
    // flagged charge and fired on card-not-present cases in iteration 6.
    expect(structural?.contradicts).toContain("account_takeover");
  });
});
