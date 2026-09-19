import { describe, expect, it } from "vitest";
import {
  BASELINE_CONFIRMED_RATE,
  COMMUNITY_PARAMS,
  DISCOVERY_MIN_CONFIRMED_PCT,
  KNOWN,
  LOOSE_MAX_HUB_DEGREE,
  runQuery,
} from "./helpers.js";

// These algorithms are periodic batch jobs (gsql/install.ts runs them after
// every install), not per-request tools -- these tests only check their
// output shape/invariants, they don't re-run the (slow) full-graph compute.

// Total Card vertices in the loaded dataset. Every card belongs to exactly
// one component, so the component sizes must sum to this.
const TOTAL_CARDS = 16324;

describe("community_components (WCC)", () => {
  it("component sizes sum to the total number of cards, all >= 1", async () => {
    const r = await runQuery<{ component_sizes: Record<string, number> }>("community_components", {
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    const sizes = Object.values(r.component_sizes);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s >= 1)).toBe(true);
    // Every card is in exactly one component -- catches a propagation bug
    // that drops or double-counts cards.
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(TOTAL_CARDS);
  });

  // The regression this guards is the giant-component artifact documented in
  // docs/decisions.md: single-guard revisions of this query collapsed 90% of
  // all cards into one component, and even after the entity-side hub cap and
  // the 2-distinct-types rule a 274-card residual survived that turned out to
  // be a transaction-volume artifact (its members averaged 17.8x the dataset
  // footprint, at a BELOW-baseline confirmed-fraud rate). The card-side
  // min_overlap_pct guard brought the largest component to 41. The bound here
  // is deliberately loose (1% of all cards) so it tracks the structural
  // property -- "no giant component" -- rather than today's exact number.
  it("produces no giant component", async () => {
    const r = await runQuery<{ component_sizes: Record<string, number> }>("community_components", {
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    const sizes = Object.values(r.component_sizes);
    const largest = Math.max(...sizes);
    expect(largest).toBeLessThan(TOTAL_CARDS * 0.01);
  });

  it("finds real multi-card communities, not just singletons", async () => {
    const r = await runQuery<{ component_sizes: Record<string, number> }>("community_components", {
      as_of: KNOWN.lateAsOf,
      ...COMMUNITY_PARAMS,
    });
    const multi = Object.values(r.component_sizes).filter((s) => s > 1);
    expect(multi.length).toBeGreaterThan(20);
  });

  // Note on what is NOT asserted here: component count is deliberately NOT
  // monotone in as_of. min_overlap_pct measures shared entities as a
  // fraction of each card's total footprint, so later activity ENLARGES the
  // denominator and can dissolve a link that qualified at an earlier
  // snapshot. Measured on the real graph: 15,209 components as of
  // 2016-08-01 vs 15,825 as of 2016-12-31 -- fewer components earlier, the
  // opposite of what an unnormalized rule would give. That is a property of
  // a relative evidence bar, not a bug: a coincidence that looked
  // distinctive early can stop looking distinctive once a card turns out to
  // touch hundreds of entities. See docs/decisions.md.
  it("honors as_of: before any history every card is its own component", async () => {
    const early = await runQuery<{ component_sizes: Record<string, number> }>("community_components", {
      as_of: KNOWN.asOfBeforeAnyHistory,
      ...COMMUNITY_PARAMS,
    });
    const sizes = Object.values(early.component_sizes);
    // No CARD_DEVICE/CARD_ADDRESS/CARD_RECIPIENT_EMAIL edge qualifies yet,
    // so nothing can be adjacent to anything.
    expect(sizes.length).toBe(TOTAL_CARDS);
    expect(sizes.every((s) => s === 1)).toBe(true);
  });
});

describe("label_propagation", () => {
  it("cluster sizes sum to the total number of cards, all >= 1", async () => {
    const r = await runQuery<{ cluster_sizes: Record<string, number> }>("label_propagation", {
      as_of: KNOWN.lateAsOf,
      max_hub_degree: LOOSE_MAX_HUB_DEGREE,
    });
    const sizes = Object.values(r.cluster_sizes);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s >= 1)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(TOTAL_CARDS);
  });
});

describe("hub_devices", () => {
  it("returns devices sorted by degree descending, all with degree > 1", async () => {
    const r = await runQuery<{ hub_devices: { device_id: string; degree: number }[] }>("hub_devices", {
      as_of: KNOWN.lateAsOf,
    });
    expect(r.hub_devices.length).toBeGreaterThan(0);
    expect(r.hub_devices.every((d) => d.degree > 1)).toBe(true);
    for (let i = 1; i < r.hub_devices.length; i++) {
      expect(r.hub_devices[i - 1].degree).toBeGreaterThanOrEqual(r.hub_devices[i].degree);
    }
  });
});

describe("shortest_path", () => {
  it("a card is 0 hops from itself", async () => {
    const r = await runQuery<{ found: boolean; hops: number }>("shortest_path", {
      from_card_id: KNOWN.txnCardId,
      to_card_id: KNOWN.txnCardId,
      max_hops: 3,
      max_hub_degree: LOOSE_MAX_HUB_DEGREE,
      as_of: KNOWN.lateAsOf,
    });
    expect(r.found).toBe(true);
    expect(r.hops).toBe(0);
  });

  it("reports not found for an unrelated card outside max_hops", async () => {
    const r = await runQuery<{ found: boolean }>("shortest_path", {
      from_card_id: KNOWN.txnCardId,
      to_card_id: "C99999-K1",
      max_hops: 2,
      max_hub_degree: LOOSE_MAX_HUB_DEGREE,
      as_of: KNOWN.lateAsOf,
    });
    expect(r.found).toBe(false);
  });
});

describe("discovery_report", () => {
  const params = {
    as_of: KNOWN.lateAsOf,
    ...COMMUNITY_PARAMS,
    min_confirmed_pct: DISCOVERY_MIN_CONFIRMED_PCT,
  };

  // Previously this asserted only `confirmed_fraud_rate >= 0.5`. That bar is
  // 33 points BELOW the dataset's 83.2% baseline, so it passed for any
  // cluster with cases at all and the pass reported a below-baseline
  // component as a discovered fraud ring. The bar now has to beat the
  // baseline to mean anything -- see docs/decisions.md.
  it("every discovered component beats the dataset-wide confirmed-fraud baseline", async () => {
    const r = await runQuery<{
      top_discovered_components: { comp_id: string; size: number; n_cases: number; n_confirmed: number }[];
    }>("discovery_report", params);
    expect(r.top_discovered_components.length).toBeLessThanOrEqual(3);
    for (const c of r.top_discovered_components) {
      expect(c.size).toBeGreaterThanOrEqual(2);
      expect(c.n_cases).toBeGreaterThanOrEqual(2);
      const rate = c.n_confirmed / c.n_cases;
      expect(rate).toBeGreaterThanOrEqual(DISCOVERY_MIN_CONFIRMED_PCT / 100);
      expect(rate).toBeGreaterThan(BASELINE_CONFIRMED_RATE);
    }
  });

  it("actually discovers something on the real dataset", async () => {
    const r = await runQuery<{ top_discovered_components: unknown[] }>("discovery_report", params);
    expect(r.top_discovered_components.length).toBeGreaterThan(0);
  });

  // Regression test for a real defect: discovery_report writes its Pattern
  // ids as "disc_c_<smallest member card id>" and community_lookup
  // synthesizes "comm_<smallest member card id>", and the code claimed the
  // two agree. They silently did not, because the two queries used DIFFERENT
  // adjacency rules, so they found different components with different
  // smallest members. The agent would get one membership from get_community
  // and another from the discovered pattern for the same cluster.
  it("discovered community ids and sizes agree with community_lookup", async () => {
    const r = await runQuery<{
      top_discovered_components: { comp_id: string; size: number; n_cases: number; n_confirmed: number }[];
    }>("discovery_report", params);
    expect(r.top_discovered_components.length).toBeGreaterThan(0);
    for (const c of r.top_discovered_components) {
      const lookup = await runQuery<{ community_id: string; size: number; confirmed_fraud_rate: number }>(
        "community_lookup",
        { card_id: c.comp_id, as_of: KNOWN.lateAsOf, ...COMMUNITY_PARAMS },
      );
      expect(lookup.community_id).toBe(`comm_${c.comp_id}`);
      expect(lookup.size).toBe(c.size);
    }
  });
});
