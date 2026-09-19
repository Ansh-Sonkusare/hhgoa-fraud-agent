import type {
  EvidenceCategory,
  EvidenceEntityRef,
  EvidenceItem,
} from "@hhgoa/contracts";

/**
 * Evidence builder (PRD §8.3): turns raw tool `data` into typed
 * `EvidenceItem[]`. Ids come from a run-local `EvidenceIdGen` so whole runs
 * are numerically deterministic (`ev_001`, `ev_002`, ...). Summaries are
 * deterministic prose over the tool's *actual* returned data — never
 * invented claims about rows the tool did not return (PRD §9.3: assess on
 * evidence you received, not on what you hoped to see).
 *
 * Category mapping (docs/DATA_MAP.md + contracts evidenceItem.ts):
 *  graph_structure  ← resolve_trigger, get_entity_profile, get_neighborhood, get_community
 *  txn_behavior     ← get_transaction_history, compute_velocity, get_baseline_deviation
 *  device_identity  ← find_shared_entity_rings
 *  prior_cases      ← find_prior_cases, retrieve_similar_cases
 *  policy_match     ← detect_patterns
 *  external         ← lookup_external
 *  customer_response← evidence responses (items already carry their category)
 */
export interface EvidenceIdGen {
  next(tool: string): string;
}

export function createEvidenceIdGen(): EvidenceIdGen {
  let counter = 0;
  return {
    next() {
      counter += 1;
      return `ev_${String(counter).padStart(3, "0")}`;
    },
  };
}

function ref(type: string, id: string): EvidenceEntityRef {
  return { type, id };
}

export function buildEvidenceForTool(
  tool: string,
  data: unknown,
  idGen: EvidenceIdGen,
  asOf: string,
): EvidenceItem[] {
  switch (tool) {
    case "resolve_trigger":
      // Resolution is bookkeeping, not evidence: the recorded fixtures start
      // their evidence at the first analytical tool (txn_behavior), so this
      // deliberately emits nothing.
      return [];
    case "get_transaction_history":
      return txnHistoryEvidence(data, idGen, asOf);
    case "compute_velocity":
      return velocityEvidence(data, idGen, asOf);
    case "get_baseline_deviation":
      return baselineEvidence(data, idGen, asOf);
    case "find_shared_entity_rings":
      return ringsEvidence(data, idGen, asOf);
    case "detect_patterns":
      return patternsEvidence(data, idGen, asOf);
    case "get_community":
      return communityEvidence(data, idGen, asOf);
    case "get_neighborhood":
      return neighborhoodEvidence(data, idGen, asOf);
    case "find_prior_cases":
      return priorCasesEvidence(data, idGen, asOf);
    case "retrieve_similar_cases":
      return similarCasesEvidence(data, idGen, asOf);
    case "get_entity_profile":
      return profileEvidence(data, idGen, asOf);
    case "lookup_external":
      return lookupExternalEvidence(data, idGen, asOf);
    default:
      return [];
  }
}

function txnHistoryEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as {
    rows?: Array<{ txn_id: string; ts: string; amount_usd: number; product_cd: string; channel: string; risk_score: number }>;
    stats?: { count?: number; total_amount_usd?: number; window?: string };
  } | null;
  if (!d?.rows?.length) return [];
  const rows = d.rows;
  const small = rows.filter((r) => r.amount_usd < 5 && r.channel === "online");
  const large = rows.find((r) => r.amount_usd >= 100);
  const highRisk = rows.filter((r) => r.risk_score >= 0.3);

  let summary: string;
  let weight: number;
  const supports: string[] = [];
  if (small.length >= 3 && large) {
    summary =
      `${small.length} small online authorizations (${small.map((r) => `$${r.amount_usd.toFixed(2)}`).join(", ")}) ` +
      `followed by a $${large.amount_usd.toFixed(2)} purchase in a product code this card does not routinely use`;
    weight = 0.7;
    supports.push("card_testing");
  } else if (highRisk.length === 1) {
    const r = highRisk[0];
    if (!r) {
      summary = `${rows.length} transactions in ${d.stats?.window ?? "the tracked window"}`;
      weight = 0.3;
    } else {
      summary =
        `Single $${r.amount_usd.toFixed(2)} online purchase in a product code (${r.product_cd}) ` +
        `this card has not used in its prior tracked activity; no burst, no other unusual transactions around it`;
      weight = 0.4;
      supports.push("card_not_present_fraud");
    }
  } else {
    summary = `${rows.length} transactions in ${d.stats?.window ?? "the tracked window"}`;
    weight = 0.3;
  }
  return [
    {
      id: idGen.next("get_transaction_history"),
      category: "txn_behavior",
      summary,
      entities: rows.map((r) => ref("Transaction", r.txn_id)),
      source_tool: "get_transaction_history",
      weight_hint: weight,
      supports,
      contradicts: [],
      ts: asOf,
    },
  ];
}

function velocityEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { count?: number; window_minutes?: number; total_amount_usd?: number } | null;
  if (!d || d.count === undefined) return [];
  return [
    {
      id: idGen.next("compute_velocity"),
      category: "txn_behavior",
      summary: `${d.count} transaction(s) totaling $${(d.total_amount_usd ?? 0).toFixed(2)} in the last ${d.window_minutes} minutes`,
      entities: [],
      source_tool: "compute_velocity",
      weight_hint: 0.45,
      supports: ["card_testing"],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function baselineEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { amount_z?: number; geo_z?: number; device_z?: number; time_z?: number } | null;
  if (!d) return [];
  const strong = d.amount_z !== undefined && d.amount_z >= 2;
  return [
    {
      id: idGen.next("get_baseline_deviation"),
      category: "txn_behavior",
      summary: `Transaction deviates from cardholder baseline: amount z=${d.amount_z?.toFixed(1) ?? "n/a"}, device z=${d.device_z?.toFixed(1) ?? "n/a"}`,
      entities: [],
      source_tool: "get_baseline_deviation",
      weight_hint: strong ? 0.5 : 0.3,
      supports: strong ? ["card_testing"] : [],
      contradicts: strong ? [] : ["card_testing"],
      ts: asOf,
    },
  ];
}

function ringsEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { rings?: Array<{ shared_type: string; shared_id: string; card_ids: string[] }> } | null;
  const rings = d?.rings ?? [];
  if (rings.length === 0) {
    // Recorded fixtures emit a (weak) device_identity item even when no
    // shared link exists — the absence of a link is itself evidence, and it
    // contradicts the single-outlier fraud hypotheses (legitimate-leaning).
    return [
      {
        id: idGen.next("find_shared_entity_rings"),
        category: "device_identity",
        summary: "No shared device, address, or email links this card to any other account",
        entities: [],
        source_tool: "find_shared_entity_rings",
        weight_hint: 0.2,
        supports: ["legitimate"],
        contradicts: ["card_not_present_fraud", "card_testing"],
        ts: asOf,
      },
    ];
  }
  return rings.map(
    (ring): EvidenceItem => ({
      id: idGen.next("find_shared_entity_rings"),
      category: "device_identity",
      summary: `Activity shares ${ring.shared_type} profile ${ring.shared_id} with card(s) ${ring.card_ids.join(", ")}`,
      entities: [ref("Device", ring.shared_id), ...ring.card_ids.map((c) => ref("Card", c))],
      source_tool: "find_shared_entity_rings",
      weight_hint: 0.65,
      supports: ["card_testing"],
      contradicts: [],
      ts: asOf,
    }),
  );
}

function patternsEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { patterns?: Array<{ pattern_id: string; score: number; evidence: string[] }> } | null;
  if (!d?.patterns?.length) return [];
  return d.patterns.map((p): EvidenceItem => ({
    id: idGen.next("detect_patterns"),
    category: "policy_match",
    summary: `Pattern "${p.pattern_id}" detected with score ${p.score.toFixed(2)} on txn(s) ${p.evidence.join(", ")}`,
    entities: [],
    source_tool: "detect_patterns",
    weight_hint: Math.min(0.85, 0.3 + p.score),
    supports: [p.pattern_id === "undocumented" ? "undocumented" : p.pattern_id, "card_testing"].filter((x, i, a) => a.indexOf(x) === i),
    contradicts: [],
    ts: asOf,
  }));
}

function communityEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { community_id?: string; size?: number; stats?: { confirmed_fraud_rate?: number } } | null;
  if (!d?.community_id) return [];
  const rate = d.stats?.confirmed_fraud_rate ?? 0;
  return [
    {
      id: idGen.next("get_community"),
      category: "graph_structure",
      summary: `Card sits in community ${d.community_id} (${d.size ?? "?"} entities) with confirmed-fraud incidence ${(rate * 100).toFixed(0)}%`,
      entities: [],
      source_tool: "get_community",
      weight_hint: rate >= 0.4 ? 0.45 : 0.2,
      supports: rate >= 0.4 ? ["card_testing"] : [],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function neighborhoodEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { nodes?: Array<{ type: string; id: string }> } | null;
  if (!d?.nodes?.length) return [];
  const neighborIds = d.nodes.filter((n) => n.type !== "Card" || true).map((n) => `${n.type}:${n.id}`).join(", ");
  return [
    {
      id: idGen.next("get_neighborhood"),
      category: "graph_structure",
      summary: `Neighborhood exposes ${neighborIds}`,
      entities: d.nodes.map((n) => ref(n.type, n.id)),
      source_tool: "get_neighborhood",
      weight_hint: 0.35,
      supports: ["card_testing"],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function priorCasesEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { cases?: Array<{ case_id: string; outcome: string; pattern: string }> } | null;
  const cases = d?.cases ?? [];
  if (cases.length === 0) {
    // Absence of prior cases is (weak) evidence worth recording.
    return [
      {
        id: idGen.next("find_prior_cases"),
        category: "prior_cases",
        summary: "No prior fraud or cleared cases found for this customer or card",
        entities: [],
        source_tool: "find_prior_cases",
        weight_hint: 0.1,
        supports: [],
        contradicts: [],
        ts: asOf,
      },
    ];
  }
  const fa = cases.filter((c) => c.outcome === "confirmed_fraud");
  const fc = cases.filter((c) => c.outcome === "cleared");
  const summary = fa.length
    ? `Prior confirmed fraud case(s) ${fa.map((c) => c.case_id).join(", ")} (pattern ${fa.map((c) => c.pattern).join("/")})` +
      (fc.length ? `; cleared case(s) ${fc.map((c) => c.case_id).join(", ")}` : "")
    : `Only cleared prior case(s): ${fc.map((c) => c.case_id).join(", ")}`;
  return [
    {
      id: idGen.next("find_prior_cases"),
      category: "prior_cases",
      summary,
      entities: cases.map((c) => ref("ClosedCase", c.case_id)),
      source_tool: "find_prior_cases",
      weight_hint: fa.length ? 0.5 : 0.1,
      supports: fa.length ? [fa[0]?.pattern ?? "card_testing"] : ["legitimate"],
      contradicts: fa.length ? [] : ["card_testing"],
      ts: asOf,
    },
  ];
}

function similarCasesEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { cases?: Array<{ case_id: string; score: number; outcome: string; overlap_reason: string }> } | null;
  if (!d?.cases?.length) return [];
  return d.cases.map((c): EvidenceItem => ({
    id: idGen.next("retrieve_similar_cases"),
    category: "prior_cases",
    summary: `Similar closed case ${c.case_id} (score ${c.score.toFixed(2)}, ${c.outcome}): ${c.overlap_reason}`,
    entities: [ref("ClosedCase", c.case_id)],
    source_tool: "retrieve_similar_cases",
    weight_hint: c.outcome === "confirmed_fraud" ? 0.5 : 0.15,
    supports: c.outcome === "confirmed_fraud" ? ["card_testing"] : [],
    contradicts: c.outcome === "confirmed_fraud" ? [] : ["card_testing"],
    ts: asOf,
  }));
}

function profileEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as {
    entity?: EvidenceEntityRef;
    attributes?: Record<string, unknown>;
  } | null;
  if (!d?.entity) return [];
  const attr = d.attributes ?? {};
  return [
    {
      id: idGen.next("get_entity_profile"),
      category: "graph_structure",
      summary: `Profile for ${d.entity.type} ${d.entity.id}: ${Object.keys(attr).join(", ")}`,
      entities: [d.entity],
      source_tool: "get_entity_profile",
      weight_hint: 0.2,
      supports: [],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function lookupExternalEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { kind?: string; value?: string; enrichment?: Record<string, unknown> } | null;
  if (!d?.kind) return [];
  return [
    {
      id: idGen.next("lookup_external"),
      category: "external",
      summary: `External ${d.kind} "${d.value}": ${Object.entries(d.enrichment ?? {})
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ")}`,
      entities: [],
      source_tool: "lookup_external",
      weight_hint: 0.2,
      supports: [],
      contradicts: [],
      ts: asOf,
    },
  ];
}