import { describe, it, expect } from "vitest";
import {
  assessSharedOrigin,
  COMMUNITY_FRAUD_RATE_MIN,
  MAX_CORROBORATING_RING_SIZE,
} from "../../agent/src/sharedOrigin.js";
import {
  createFacts,
  createGatherRuntime,
  runSharedOriginCorroboration,
  runStandardGather,
  type InvestigationFacts,
} from "../../agent/src/investigation.js";
import { fakes } from "../../contracts/src/fakes.js";
import type {
  CommunityData,
  PriorCaseRef,
  ResolveTriggerData,
  SharedEntityRing,
  ToolCatalog,
  TransactionHistoryData,
} from "../../contracts/src/tools.js";
import type { ToolResult } from "../../contracts/src/toolEnvelope.js";

const AS_OF = "2016-11-12T00:35:00Z";
const PRIMARY = "C1";

function facts(): InvestigationFacts {
  const f = createFacts("HHG-SO-1", AS_OF, { kind: "risk_score", risk_score: 0.8 });
  f.primary_card = { type: "Card", id: PRIMARY };
  return f;
}

function deviceRing(size: number): SharedEntityRing {
  return {
    shared_type: "device",
    shared_id: "D1",
    card_ids: [PRIMARY, ...Array.from({ length: size - 1 }, (_, i) => `CX${i}`)],
  };
}

function community(size: number, rate: number): CommunityData {
  return { community_id: "comm_C1", size, stats: { confirmed_fraud_rate: rate } };
}

describe("assessSharedOrigin", () => {
  it("is false with no rings", () => {
    const a = assessSharedOrigin(facts());
    expect(a.shared_origin_connection).toBe(false);
    expect(a.rings).toEqual([]);
    expect(a.connected_card_ids).toEqual([]);
  });

  it("a plausible ring alone is not enough (uncorroborated)", () => {
    const f = facts();
    f.rings = [deviceRing(2)];
    const a = assessSharedOrigin(f);
    expect(a.signals.plausible_ring).toBe(true);
    expect(a.signals.prior_confirmed_fraud).toBe(false);
    expect(a.signals.community_confirmed).toBe(false);
    expect(a.shared_origin_connection).toBe(false);
    expect(a.rings).toEqual([]);
    expect(a.connected_card_ids).toEqual([]);
  });

  it("a plausible ring plus prior confirmed fraud corroborates, and reports the ring", () => {
    const f = facts();
    f.rings = [deviceRing(2)];
    f.prior_cases = [{ case_id: "CC-1", outcome: "confirmed_fraud", pattern: "card_testing" }];
    const a = assessSharedOrigin(f);
    expect(a.shared_origin_connection).toBe(true);
    expect(a.signals.prior_confirmed_fraud).toBe(true);
    expect(a.connected_card_ids).toEqual(["CX0"]);
    expect(a.device_profiles).toEqual(["D1"]);
    expect(a.reason).toContain("confirmed fraud");
  });

  it("a cleared prior case does not corroborate", () => {
    const f = facts();
    f.rings = [deviceRing(2)];
    f.prior_cases = [{ case_id: "CC-2", outcome: "cleared", pattern: "none" }];
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(false);
  });

  it("a crowd-scale ring is not plausible (HHG-007's 29-47 card devices)", () => {
    const f = facts();
    f.rings = [deviceRing(45)];
    f.prior_cases = [{ case_id: "CC-1", outcome: "confirmed_fraud", pattern: "card_testing" }];
    const a = assessSharedOrigin(f);
    expect(a.signals.plausible_ring).toBe(false);
    expect(a.shared_origin_connection).toBe(false);
    expect(a.rings).toEqual([]);
  });

  it("a fraud-concentrated community corroborates a plausible single-type ring", () => {
    const f = facts();
    f.rings = [deviceRing(2)];
    f.community = community(9, 1);
    const a = assessSharedOrigin(f);
    expect(a.signals.community_confirmed).toBe(true);
    expect(a.shared_origin_connection).toBe(true);
    expect(a.connected_card_ids).toEqual(["CX0"]);
  });

  it("a sparse community does not corroborate", () => {
    const f = facts();
    f.rings = [deviceRing(2)];
    f.community = community(1, 0);
    const a = assessSharedOrigin(f);
    expect(a.signals.community_confirmed).toBe(false);
    expect(a.shared_origin_connection).toBe(false);
  });

  it("the community bar is exactly COMMUNITY_FRAUD_RATE_MIN", () => {
    const below = facts();
    below.rings = [deviceRing(2)];
    below.community = community(6, COMMUNITY_FRAUD_RATE_MIN - 0.01);
    expect(assessSharedOrigin(below).shared_origin_connection).toBe(false);

    const at = facts();
    at.rings = [deviceRing(2)];
    at.community = community(6, COMMUNITY_FRAUD_RATE_MIN);
    expect(assessSharedOrigin(at).shared_origin_connection).toBe(true);
  });

  it("the plausibility bar is exactly MAX_CORROBORATING_RING_SIZE", () => {
    const at = facts();
    at.rings = [deviceRing(MAX_CORROBORATING_RING_SIZE)];
    at.prior_cases = [{ case_id: "CC-1", outcome: "confirmed_fraud", pattern: "card_testing" }];
    expect(assessSharedOrigin(at).signals.plausible_ring).toBe(true);

    const over = facts();
    over.rings = [deviceRing(MAX_CORROBORATING_RING_SIZE + 1)];
    over.prior_cases = [{ case_id: "CC-1", outcome: "confirmed_fraud", pattern: "card_testing" }];
    expect(assessSharedOrigin(over).signals.plausible_ring).toBe(false);
  });

  it("prior confirmed fraud with no shared ring is not a shared origin", () => {
    const f = facts();
    f.prior_cases = [{ case_id: "CC-1", outcome: "confirmed_fraud", pattern: "card_testing" }];
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(false);
  });
});

function ok<T>(tool: string, data: T): ToolResult<T> {
  return {
    ok: true,
    tool,
    as_of: AS_OF,
    via: "mcp",
    data,
    evidence_refs: [],
    truncated: false,
    latency_ms: 0,
    error: null,
  };
}

function catalogWith(opts: {
  rings: SharedEntityRing[];
  prior: PriorCaseRef[];
  community?: CommunityData;
}): { catalog: ToolCatalog; communityCalls: () => number } {
  let calls = 0;
  const overrides: Partial<ToolCatalog> = {
    resolve_trigger: async () =>
      ok("resolve_trigger", {
        card: { type: "Card", id: PRIMARY },
        txn: { type: "Transaction", id: "T1" },
        customer: { type: "Customer", id: "CUST1" },
      } as ResolveTriggerData),
    get_transaction_history: async () =>
      ok("get_transaction_history", {
        rows: [],
        stats: { count: 0, total_amount_usd: 0, window: "2h" },
      } as TransactionHistoryData),
    find_shared_entity_rings: async () =>
      ok("find_shared_entity_rings", { rings: opts.rings }),
    find_prior_cases: async () => ok("find_prior_cases", { cases: opts.prior }),
    get_community: async () => {
      calls += 1;
      return ok("get_community", opts.community ?? community(1, 0));
    },
  };
  return { catalog: { ...fakes, ...overrides } as ToolCatalog, communityCalls: () => calls };
}

async function runCorroboration(
  f: InvestigationFacts,
  opts: Parameters<typeof catalogWith>[0],
) {
  const { catalog, communityCalls } = catalogWith(opts);
  const g = createGatherRuntime({ catalog, asOf: AS_OF, facts: f });
  await runStandardGather(g);
  await runSharedOriginCorroboration(g);
  return { facts: f, communityCalls };
}

describe("runSharedOriginCorroboration", () => {
  it("asks the graph for the community when a plausible ring lacks prior-fraud corroboration", async () => {
    const { facts: f, communityCalls } = await runCorroboration(facts(), {
      rings: [deviceRing(2)],
      prior: [],
      community: community(9, 1),
    });
    expect(communityCalls()).toBe(1);
    expect(f.community).not.toBeNull();
    expect(f.connected_card_ids).toEqual(["CX0"]);
    expect(f.device_profiles).toEqual(["D1"]);
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(true);
  });

  it("does not ask when prior confirmed fraud already corroborates", async () => {
    const { facts: f, communityCalls } = await runCorroboration(facts(), {
      rings: [deviceRing(2)],
      prior: [{ case_id: "CC-1", outcome: "confirmed_fraud", pattern: "card_testing" }],
    });
    expect(communityCalls()).toBe(0);
    expect(f.community).toBeNull();
    expect(f.connected_card_ids).toEqual(["CX0"]);
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(true);
  });

  it("does not ask for a crowd-scale ring and narrows the reported cards", async () => {
    const { facts: f, communityCalls } = await runCorroboration(facts(), {
      rings: [deviceRing(45)],
      prior: [],
    });
    expect(communityCalls()).toBe(0);
    expect(f.connected_card_ids).toEqual([]);
    expect(f.device_profiles).toEqual([]);
    expect(assessSharedOrigin(f).shared_origin_connection).toBe(false);
  });

  it("does not ask when there is no shared ring at all", async () => {
    const { facts: f, communityCalls } = await runCorroboration(facts(), {
      rings: [],
      prior: [],
    });
    expect(communityCalls()).toBe(0);
    expect(f.connected_card_ids).toEqual([]);
  });
});
