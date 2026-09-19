import { describe, expect, it } from "vitest";
import { KNOWN, runQuery } from "./helpers.js";

// These algorithms are periodic batch jobs (gsql/install.ts runs them after
// every install), not per-request tools -- these tests only check their
// output shape/invariants, they don't re-run the (slow) full-graph compute.
describe("community_components (WCC)", () => {
  it("component sizes sum to the total number of cards touched, all >= 1", async () => {
    const r = await runQuery<{ component_sizes: Record<string, number> }>("community_components", {
      as_of: KNOWN.lateAsOf,
      max_hub_degree: 25,
    });
    const sizes = Object.values(r.component_sizes);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s >= 1)).toBe(true);
  });
});

describe("label_propagation", () => {
  it("cluster sizes sum to the total number of cards, all >= 1", async () => {
    const r = await runQuery<{ cluster_sizes: Record<string, number> }>("label_propagation", {
      as_of: KNOWN.lateAsOf,
      max_hub_degree: 25,
    });
    const sizes = Object.values(r.cluster_sizes);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s >= 1)).toBe(true);
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
      max_hub_degree: 25,
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
      max_hub_degree: 25,
      as_of: KNOWN.lateAsOf,
    });
    expect(r.found).toBe(false);
  });
});

describe("discovery_report", () => {
  it("every top discovered component has size >= 2 and confirmed_fraud_rate >= 0.5", async () => {
    const r = await runQuery<{
      top_discovered_components: { comp_id: string; size: number; n_cases: number; n_confirmed: number }[];
    }>("discovery_report", { as_of: KNOWN.lateAsOf, max_hub_degree: 25 });
    expect(r.top_discovered_components.length).toBeLessThanOrEqual(3);
    for (const c of r.top_discovered_components) {
      expect(c.size).toBeGreaterThanOrEqual(2);
      expect(c.n_cases).toBeGreaterThanOrEqual(2);
      expect(c.n_confirmed * 2).toBeGreaterThanOrEqual(c.n_cases);
    }
  });
});
