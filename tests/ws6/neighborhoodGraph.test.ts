import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@hhgoa/contracts";
import { buildGraph, extractRings, MAX_CARDS_PER_GROUP } from "../../ui/lib/neighborhoodGraph.js";

let seq = 0;
const event = (type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent => ({
  seq: seq++,
  ts: "2016-11-22T02:30:00Z",
  case_id: "HHG-T",
  type,
  state: "INVESTIGATING",
  payload,
});

const cardIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `X${String(i).padStart(5, "0")}-K1`);

/** The tool_call / tool_result pair exactly as the live agent emits them (captured from HHG-006/HHG-017). */
const liveRingEvents = (flagged: string, sharedType: string, sharedId: string, members: string[]): AgentEvent[] => [
  event("tool_call", { tool: "find_shared_entity_rings", args: { entity: { type: "Card", id: flagged }, as_of: "2016-11-22T02:30:00Z" } }),
  event("tool_result", {
    tool: "find_shared_entity_rings",
    result: {
      ok: true,
      tool: "find_shared_entity_rings",
      via: "mcp",
      data: { rings: [{ shared_type: sharedType, shared_id: sharedId, card_ids: [flagged, ...members] }] },
    },
  }),
];

describe("buildGraph (Neighborhood graph panel)", () => {
  it("reads rings from the live payload shape result.data.rings", () => {
    const events = liveRingEvents("C07297-K1", "device", "7059dc480f519e47", cardIds(5));
    const g = buildGraph("HHG-T", events);

    const hub = g.nodes.find((n) => n.id === "Device:7059dc480f519e47");
    expect(hub?.role).toBe("hub");
    // case -> flagged card -> hub -> 5 members
    expect(g.nodes.filter((n) => n.type === "Card")).toHaveLength(6);
    expect(g.links).toContainEqual({ source: "Case:HHG-T", target: "Card:C07297-K1", label: "flagged card" });
    expect(g.links).toContainEqual({ source: "Card:C07297-K1", target: "Device:7059dc480f519e47", label: "shares device" });
    expect(g.hiddenCards).toBe(0);
  });

  it("still reads the flatter shapes the fixture recordings use", () => {
    const ring = { shared_type: "device", shared_id: "D1", card_ids: ["C1", "C2"] };
    expect(extractRings({ rings: [ring] })).toEqual([ring]);
    expect(extractRings({ result: { rings: [ring] } })).toEqual([ring]);
    expect(extractRings({ result: { data: { rings: [ring] } } })).toEqual([ring]);
    expect(extractRings({ result: { data: {} } })).toEqual([]);

    const g = buildGraph("HHG-T", [event("tool_result", { tool: "find_shared_entity_rings", rings: [ring] })]);
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["Device:D1", "Card:C1", "Card:C2"]));
    // No flagged card is known here, so the group hangs off the case itself.
    expect(g.links).toContainEqual({ source: "Case:HHG-T", target: "Device:D1", label: "shares device" });
  });

  it("caps a huge group, and says exactly how many real members it left out", () => {
    const events = liveRingEvents("C1-K1", "address", "492.0", cardIds(49)); // 50 cards in the group
    const g = buildGraph("HHG-T", events);

    const hub = g.nodes.find((n) => n.id === "Address:492.0")!;
    const drawn = g.nodes.filter((n) => n.type === "Card" && n.role === "leaf");
    expect(drawn).toHaveLength(MAX_CARDS_PER_GROUP);
    expect(hub.hidden).toBe(49 - MAX_CARDS_PER_GROUP);
    expect(g.hiddenCards).toBe(49 - MAX_CARDS_PER_GROUP);
    // Nothing is invented: every drawn card came from the ring's own list.
    for (const n of drawn) expect(cardIds(49)).toContain(n.label);
  });

  it("does not wire every ring member straight to the case through the ring's evidence item", () => {
    const events = [
      ...liveRingEvents("C1-K1", "device", "D1", cardIds(20)),
      event("evidence_added", {
        evidence: {
          id: "ev_1",
          category: "device_identity",
          summary: "Shares device profile D1 with 20 other cards",
          entities: [{ type: "Device", id: "D1" }, ...cardIds(20).map((id) => ({ type: "Card", id }))],
          source_tool: "find_shared_entity_rings",
          weight_hint: 0.3,
          supports: [],
          contradicts: [],
          ts: "2016-11-22T02:30:00Z",
        },
      }),
    ];
    const g = buildGraph("HHG-T", events);
    expect(g.links.filter((l) => l.source === "Case:HHG-T").map((l) => l.target)).toEqual(["Card:C1-K1"]);
    // ...and the ring's hub is not duplicated under the evidence's own (mis)label.
    expect(g.nodes.filter((n) => n.label === "D1")).toHaveLength(1);
  });

  it("draws non-ring evidence entities (transactions, prior cases) around the case", () => {
    const events = [
      event("evidence_added", {
        evidence: {
          id: "ev_2",
          category: "prior_cases",
          summary: "Only cleared prior case(s): CC-1383",
          entities: [{ type: "ClosedCase", id: "CC-1383" }],
          source_tool: "find_prior_cases",
          weight_hint: -0.2,
          supports: [],
          contradicts: [],
          ts: "2016-11-22T02:30:00Z",
        },
      }),
    ];
    const g = buildGraph("HHG-T", events);
    expect(g.links).toEqual([{ source: "Case:HHG-T", target: "ClosedCase:CC-1383", label: "prior_cases" }]);
  });

  it("is a lone root node (empty state) when the run has produced no graph evidence", () => {
    const g = buildGraph("HHG-T", [event("state_entered", {})]);
    expect(g.nodes).toHaveLength(1);
    expect(g.links).toHaveLength(0);
  });
});
