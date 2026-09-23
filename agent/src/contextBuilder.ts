import type { Assessment, EvidenceCategory, EvidenceItem, Trigger } from "@hhgoa/contracts";
import { estimateTokens } from "./structured.js";
import { topFraudHypothesis } from "./assess.js";
import { isPatternShape, PATTERN_SHAPE_PREFIX } from "./evidenceBuilder.js";

const PATTERN_SHAPE_PREFIX_LEN = PATTERN_SHAPE_PREFIX.length;

/**
 * Context bundle for the LLM assessor (PRD §9.3 "delivers a compact,
 * no-nonsense brief"). Never exposes raw transaction rows — only evidence
 * ids, categories, summaries and weight hints (dataset README: rows are
 * never rendered into prompts). Kept under `maxTokens` by dropping the
 * lowest-weight items first.
 */

export interface ContextBundle {
  case_id: string;
  as_of: string;
  trigger_summary: string;
  risk_score: number;
  evidence: Array<{
    id: string;
    category: EvidenceCategory;
    summary: string;
    weight_hint: number;
    supports?: string[];
    contradicts?: string[];
    source?: string;
  }>;
  pattern_hints: string[];
  token_estimate: number;
  truncated?: boolean;
}

export const CONTEXT_MAX_TOKENS = 6000;

function triggerSummary(t: Trigger): string {
  switch (t.kind) {
    case "risk_score":
      return `risk_score event: ${t.txn_id ?? t.card_id ?? "card/transaction"} scored ${t.risk_score.toFixed(2)}`;
    case "customer_report":
      return `customer_report: reported the transaction`;
    case "analyst_request":
      return `analyst_request: manual review requested`;
  }
}

export function buildContextBundle(options: {
  case_id: string;
  as_of: string;
  trigger: Trigger;
  risk_score: number;
  evidence: EvidenceItem[];
  pattern_hints?: string[];
  maxTokens?: number;
}): ContextBundle {
  const maxTokens = options.maxTokens ?? CONTEXT_MAX_TOKENS;

  const rows = options.evidence.map((e) => ({
    id: e.id,
    category: e.category,
    summary: e.summary,
    weight_hint: e.weight_hint,
    ...(e.supports && e.supports.length ? { supports: e.supports } : {}),
    ...(e.contradicts && e.contradicts.length ? { contradicts: e.contradicts } : {}),
    source: e.source_tool,
  }));

  // Drop lowest-weight items until the bundle fits.
  const sorted = [...rows].sort((a, b) => b.weight_hint - a.weight_hint);
  let kept = sorted;
  for (;;) {
    const bundle: ContextBundle = {
      case_id: options.case_id,
      as_of: options.as_of,
      trigger_summary: triggerSummary(options.trigger),
      risk_score: options.risk_score,
      evidence: kept,
      pattern_hints: options.pattern_hints ?? [],
      token_estimate: 0,
    };
    const estimate = estimateTokens(JSON.stringify({ ...bundle, token_estimate: 0 }));
    if (estimate <= maxTokens || kept.length <= 1) {
      bundle.token_estimate = estimate;
      bundle.truncated = kept.length < rows.length;
      return bundle;
    }
    kept = kept.slice(0, kept.length - 1);
  }
}

export function renderContextBundle(bundle: ContextBundle): string {
  const lines: string[] = [
    `CASE: ${bundle.case_id}  AS_OF: ${bundle.as_of}`,
    `TRIGGER: ${bundle.trigger_summary} (risk_score ${bundle.risk_score.toFixed(2)})`,
  ];
  if (bundle.pattern_hints.length) {
    lines.push(`PATTERNS: ${bundle.pattern_hints.join(", ")}`);
  }
  const shape = bundle.evidence.filter(isPatternShape);
  if (shape.length) {
    // Which fraud pattern the case would be *if* it is fraud. Kept apart from
    // the evidence list so fits/rules-out are not read as votes for fraud.
    lines.push("PATTERN SHAPE (decides which fraud pattern this would be if it is fraud; not evidence that it is fraud):");
    for (const e of shape) {
      const flags = [
        ...(e.supports?.length ? [`fits:${e.supports.join(",")}`] : []),
        ...(e.contradicts?.length ? [`rules_out:${e.contradicts.join(",")}`] : []),
      ];
      lines.push(`  [${e.id}] ${flags.join(", ")}: ${e.summary.slice(PATTERN_SHAPE_PREFIX_LEN)}`);
    }
  }
  lines.push("EVIDENCE:");
  // One line per shared device profile / billing region / email domain is
  // context, not a vote (evidenceBuilder.ts ringsEvidence: weight 0.15,
  // supports nothing); the aggregate ring item carries the count and the vote.
  // A card in a busy ring filed hundreds of them -- CC-2247's brief had 264 of
  // 277 items, ~20k characters -- which pushed prompts to 13k tokens and left
  // no room to run two cases side by side. They stay in the case record; the
  // brief says how many there are.
  const ringDetail = bundle.evidence.filter(isRingDetail);
  for (const e of bundle.evidence) {
    if (isPatternShape(e)) continue;
    if (isRingDetail(e)) continue;
    const flags = [
      ...(e.supports?.length ? [`supports:${e.supports.join(",")}`] : []),
      ...(e.contradicts?.length ? [`contradicts:${e.contradicts.join(",")}`] : []),
    ];
    lines.push(
      `  [${e.id}] ${e.category} (w=${e.weight_hint.toFixed(2)}${flags.length ? ", " + flags.join(", ") : ""}): ${e.summary}`,
    );
  }
  if (ringDetail.length) {
    const ids = ringDetail.map((e) => e.id);
    lines.push(
      `  [${ids[0]}..${ids[ids.length - 1]}] device_identity (w=0.15): ${ringDetail.length} individual shared ` +
        "device profile / billing region / email-domain listings, recorded in the case file; they carry no vote " +
        "and are summarised by the card's shared-profile item",
    );
  }
  if (bundle.truncated) {
    lines.push("NOTE: lowest-weight evidence omitted to fit token budget.");
  }
  return lines.join("\n");
}

function isRingDetail(e: ContextBundle["evidence"][number]): boolean {
  return (
    // 0.15 is the per-profile listing; the aggregate item (0.2 or 0.6) and the
    // email-domain items (0.2) stay in the brief.
    e.source === "find_shared_entity_rings" &&
    e.weight_hint <= 0.15 &&
    !e.supports?.length &&
    !e.contradicts?.length
  );
}

/** Enum of evidence categories for the assessor prompt. */
export function orderedCategories(bundle: ContextBundle): EvidenceCategory[] {
  const seen = new Set<EvidenceCategory>();
  const out: EvidenceCategory[] = [];
  for (const e of [...bundle.evidence].sort((a, b) => b.weight_hint - a.weight_hint)) {
    if (!seen.has(e.category)) {
      seen.add(e.category);
      out.push(e.category);
    }
  }
  return out;
}