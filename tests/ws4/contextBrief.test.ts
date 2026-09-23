import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";
import { buildContextBundle, renderContextBundle } from "../../agent/src/contextBuilder.js";
import { PATTERN_SHAPE_PREFIX, isPatternShape } from "../../agent/src/evidenceBuilder.js";

// A pattern-shape claim (the flagged charge's channel, whether its device was
// new) says which fraud pattern a case would be if it is fraud. Listed among
// ordinary evidence with `supports:` it was read as a vote for fraud and
// pushed cleared model alerts to p~0.9 (iteration 11). The brief renders it
// in its own section so it can steer the pattern without voting on the verdict.

function item(id: string, summary: string, supports: string[], contradicts: string[] = []): EvidenceItem {
  return {
    id,
    category: "txn_behavior",
    summary,
    weight_hint: 0.5,
    source_tool: "get_transaction_history",
    entity_refs: [],
    supports,
    contradicts,
  } as unknown as EvidenceItem;
}

const shape = item(
  "ev_001",
  PATTERN_SHAPE_PREFIX + "the flagged transaction was card-not-present (online)",
  ["card_not_present_fraud"],
  ["out_of_region_use"],
);
const ordinary = item("ev_002", "Three small online authorizations within an hour", ["card_testing"]);

function brief(): string {
  return renderContextBundle(
    buildContextBundle({
      case_id: "CC-TEST",
      as_of: "2016-08-01 00:00:00",
      trigger: { kind: "risk_score", txn_id: "1", risk_score: 0.9 } as never,
      risk_score: 0.9,
      evidence: [shape, ordinary],
    }),
  );
}

describe("pattern-shape claims in the assessor brief", () => {
  it("recognises the marker", () => {
    expect(isPatternShape(shape)).toBe(true);
    expect(isPatternShape(ordinary)).toBe(false);
  });

  it("renders shape claims in their own section, before and outside EVIDENCE", () => {
    const text = brief();
    const shapeAt = text.indexOf("PATTERN SHAPE");
    const evidenceAt = text.indexOf("EVIDENCE:");
    expect(shapeAt).toBeGreaterThan(-1);
    expect(shapeAt).toBeLessThan(evidenceAt);
    const evidenceBlock = text.slice(evidenceAt);
    expect(evidenceBlock).not.toContain("ev_001");
    expect(evidenceBlock).toContain("[ev_002]");
  });

  it("never phrases a shape claim as support for fraud", () => {
    const shapeLine = brief()
      .split("\n")
      .find((l) => l.includes("[ev_001]"));
    expect(shapeLine).toBeDefined();
    expect(shapeLine).toContain("fits:card_not_present_fraud");
    expect(shapeLine).toContain("rules_out:out_of_region_use");
    expect(shapeLine).not.toContain("supports:");
    expect(shapeLine).not.toContain(PATTERN_SHAPE_PREFIX);
  });
});

describe("per-profile ring listings in the assessor brief", () => {
  const ring = (id: string, weight: number, summary: string, supports: string[] = []): EvidenceItem => ({
    id, category: "device_identity", summary, entities: [], source_tool: "find_shared_entity_rings",
    weight_hint: weight, supports, contradicts: [], ts: "2016-08-01 00:00:00",
  });
  const items: EvidenceItem[] = [
    ...Array.from({ length: 40 }, (_, i) => ring(`ev_${100 + i}`, 0.15, `Activity shares device profile d${i} with card(s) C1-K1`)),
    ring("ev_200", 0.6, "Card's activity in the last 30 days shares 40 device profiles / billing regions with 31 other card(s)", ["fraud"]),
    ring("ev_201", 0.2, "Recipient email domain rare.example is also used by card(s) C2-K1"),
  ];
  const brief = renderContextBundle(buildContextBundle({
    case_id: "CC-X", as_of: "2016-08-01 00:00:00", trigger: { kind: "risk_score", risk_score: 0.8 },
    risk_score: 0.8, evidence: items, maxTokens: 100_000,
  }));

  it("collapses the non-voting listings into one line with their count", () => {
    expect(brief).not.toContain("Activity shares device profile d7");
    expect(brief).toContain("40 individual shared device profile / billing region / email-domain listings");
  });

  it("keeps the aggregate ring item and email-domain items verbatim", () => {
    expect(brief).toContain("[ev_200]");
    expect(brief).toContain("supports:fraud");
    expect(brief).toContain("rare.example");
  });
});
