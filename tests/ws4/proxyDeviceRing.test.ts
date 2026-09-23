import { describe, it, expect } from "vitest";
import {
  buildEvidenceForTool,
  createEvidenceIdGen,
  readProxyDeviceRing,
  describeProxyDeviceRing,
} from "../../agent/src/evidenceBuilder.js";
import { finalizeAssessment, resolvePatternLabel } from "../../agent/src/assess.js";
import type { AssessmentProposal } from "../../agent/src/assess.js";
import { recommendActions } from "../../agent/src/recommend.js";
import { createFacts } from "../../agent/src/investigation.js";

const AS_OF = "2016-12-05T10:00:00Z";

/** The shape measured on HHG-014's flagged charge: 20 cards, 26 uses, all proxy, all new. */
const RING_ATTRS = {
  device_id: "D-RING",
  device_cards_30d: 20,
  device_uses_30d: 26,
  device_anon_proxy_uses_30d: 26,
  device_new_uses_30d: 26,
};

describe("readProxyDeviceRing (thresholds measured on all closed cases)", () => {
  it("fires on the measured ring shape", () => {
    const ring = readProxyDeviceRing(RING_ATTRS);
    expect(ring).toMatchObject({ device_id: "D-RING", cards: 20, uses: 26, anon_share: 1, new_share: 1 });
  });

  it("does not fire on the nearest non-ring devices", () => {
    // CC-0178: 4 cards at 60% / 60%.
    expect(readProxyDeviceRing({ ...RING_ATTRS, device_cards_30d: 4, device_uses_30d: 10, device_anon_proxy_uses_30d: 6, device_new_uses_30d: 6 })).toBeNull();
    // CC-4122: 5 cards, all proxy, but only 20% presenting as new.
    expect(readProxyDeviceRing({ ...RING_ATTRS, device_cards_30d: 5, device_uses_30d: 10, device_anon_proxy_uses_30d: 10, device_new_uses_30d: 2 })).toBeNull();
  });

  it("does not fire on an ordinary shared hub device", () => {
    // Hubs are shared by many cards (89% of every class shares the flagged
    // device with 2+ cards) but are not reached through an anonymous proxy.
    expect(readProxyDeviceRing({ ...RING_ATTRS, device_cards_30d: 231, device_uses_30d: 900, device_anon_proxy_uses_30d: 12, device_new_uses_30d: 300 })).toBeNull();
  });

  it("returns null rather than guessing when the counts are absent", () => {
    expect(readProxyDeviceRing({})).toBeNull();
    expect(readProxyDeviceRing({ ...RING_ATTRS, device_id: "" })).toBeNull();
    expect(readProxyDeviceRing({ ...RING_ATTRS, device_uses_30d: 0 })).toBeNull();
  });
});

describe("transaction profile evidence", () => {
  const profile = (attrs: Record<string, unknown>) => ({ entity: { type: "Transaction", id: "3500001" }, attributes: attrs });

  it("files one graph claim for undocumented when the flagged device is the ring", () => {
    const items = buildEvidenceForTool("get_entity_profile", profile(RING_ATTRS), createEvidenceIdGen(), AS_OF);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      category: "device_identity",
      source_tool: "get_entity_profile",
      supports: ["undocumented"],
    });
    expect(items[0]!.entities).toContainEqual({ type: "Device", id: "D-RING" });
    expect(items[0]!.summary).toContain("20 different cards");
  });

  it("files nothing for an ordinary device, not a bare profile item", () => {
    const attrs = { ...RING_ATTRS, device_anon_proxy_uses_30d: 0 };
    expect(buildEvidenceForTool("get_entity_profile", profile(attrs), createEvidenceIdGen(), AS_OF)).toEqual([]);
  });
});

function proposal(hyps: Array<[string, number]>): AssessmentProposal {
  return {
    hypotheses: hyps.map(([fraud_type, probability]) => ({ fraud_type, probability, supporting: [], contradicting: [] })),
    risk_level: "MEDIUM",
    risk_score: 0.5,
    confidence: 0.7,
    legit_hypothesis_probability: hyps.find(([t]) => t === "legitimate")?.[1] ?? 0.1,
  };
}
const SUFFICIENT = { sufficient: false, missing: [], stop_reason: null };

describe("resolvePatternLabel", () => {
  it("names undocumented when the graph found the ring, whatever the model leaned toward", () => {
    const a = finalizeAssessment(proposal([["card_not_present_new_device", 0.6], ["legitimate", 0.2]]), [], SUFFICIENT);
    expect(resolvePatternLabel(a, true)).toBe("undocumented");
  });

  it("does not trust an undocumented label the graph did not support", () => {
    const a = finalizeAssessment(
      proposal([["undocumented", 0.6], ["card_not_present_fraud", 0.3], ["legitimate", 0.1]]),
      [],
      SUFFICIENT,
    );
    expect(resolvePatternLabel(a, false)).toBe("card_not_present_fraud");
  });

  it("leaves a documented label alone", () => {
    const a = finalizeAssessment(proposal([["card_testing", 0.7], ["legitimate", 0.2]]), [], SUFFICIENT);
    expect(resolvePatternLabel(a, false)).toBe("card_testing");
  });
});

describe("R9 on the device ring", () => {
  function ringFacts() {
    const f = createFacts("HHG-R9", AS_OF, { kind: "risk_score", risk_score: 0.9, txn_id: "3500001" });
    f.exposure_usd = 120;
    f.proxy_device_ring = readProxyDeviceRing(RING_ATTRS);
    return f;
  }
  const names = (r: ReturnType<typeof recommendActions>) => r.actions.map((a) => a.action);

  it("opens a case and escalates even below the report threshold", () => {
    const a = finalizeAssessment(proposal([["undocumented", 0.55], ["legitimate", 0.3]]), [], SUFFICIENT);
    const r = recommendActions(ringFacts(), a, [], "uncertain");
    expect(names(r)).toEqual(expect.arrayContaining(["CREATE_CASE", "ESCALATE_TO_ANALYST"]));
    // DATASET_README line 257: a report needs fraud confirmed or strongly suspected.
    expect(names(r)).not.toContain("FILE_REPORT");
    expect(r.why.CREATE_CASE).toContain("R9");
  });

  it("files the report once fraud is strongly suspected", () => {
    const a = finalizeAssessment(proposal([["undocumented", 0.85], ["legitimate", 0.1]]), [], SUFFICIENT);
    const r = recommendActions(ringFacts(), a, [], "fraud");
    expect(names(r)).toEqual(expect.arrayContaining(["CREATE_CASE", "FILE_REPORT", "ESCALATE_TO_ANALYST"]));
    expect(new Set(names(r)).size).toBe(names(r).length);
  });

  it("does not fire on a case we are clearing", () => {
    const a = finalizeAssessment(proposal([["undocumented", 0.2], ["legitimate", 0.75]]), [], SUFFICIENT);
    const r = recommendActions(ringFacts(), a, [], "legitimate");
    expect(names(r)).not.toContain("ESCALATE_TO_ANALYST");
  });

  it("describes the ring in its own words", () => {
    const ring = readProxyDeviceRing(RING_ATTRS)!;
    expect(describeProxyDeviceRing(ring)).toMatch(/20 different cards.*100% .*anonymous proxy.*none of the five documented patterns/);
  });
});
