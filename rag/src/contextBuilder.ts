/**
 * `context_builder` (PRD §11 step 3, R4): ranks and trims hybrid-retrieval
 * results plus the agent's own evidence into a `ContextBundle` — the
 * curated, provenance-tagged payload the LLM sees instead of raw rows.
 *
 * Not a `contracts/src/tools.ts` tool — the contract defines no
 * `build_context_bundle` signature; this is the internal rag<->agent
 * handoff PRD §11 names but leaves schemaless (`types.ts` documents that).
 * The sole hard guarantees it enforces are R4's: `total_tokens` never
 * exceeds `budget_tokens` (default 6000) and every item carries an
 * `id`/`provenance_ids` entry so the answer file's `evidence[].ref` /
 * `similar_prior_cases` citations can point at exactly what the LLM saw.
 */
import type { PolicyActionName } from "@hhgoa/contracts";
import { approxTokenCount } from "./tokenCount.js";
import type { ContextBundle, ContextBundleItem } from "./types.js";

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 6000;

export interface ContextPolicyChunkInput {
  id: string;
  text: string;
  source_doc: string;
  heading_path?: string;
  pattern_id?: string;
  score: number;
}

export interface ContextPriorCaseInput {
  id: string;
  summary_text: string;
  outcome: "confirmed_fraud" | "cleared";
  score: number;
  overlap_reason: string;
}

export interface ContextPatternInput {
  pattern_id: string;
  name: string;
  required_evidence: string[];
  permitted_actions: PolicyActionName[];
  rule_refs?: string[];
}

export interface ContextEvidenceItemInput {
  id: string;
  summary: string;
  category: string;
}

export interface ContextBuildInput {
  query: string;
  policyChunks: ContextPolicyChunkInput[];
  priorCases: ContextPriorCaseInput[];
  patterns: ContextPatternInput[];
  /** The agent's own collected evidence, curated already (PRD §8.3 items). */
  evidenceItems?: ContextEvidenceItemInput[];
}

function renderPatternBlock(input: ContextPatternInput): string {
  const lines = [
    `Pattern: ${input.name} (${input.pattern_id})`,
    `Required evidence: ${input.required_evidence.length > 0 ? input.required_evidence.join(", ") : "none specified"}`,
    `Permitted actions: ${input.permitted_actions.length > 0 ? input.permitted_actions.join(", ") : "none specified"}`,
  ];
  if (input.rule_refs && input.rule_refs.length > 0) {
    lines.push(`Policy rules: ${input.rule_refs.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Rank + trim into a bundle. Item order (deterministic, testable):
 * pattern block -> evidence items (caller order) -> policy chunks by
 * score desc -> prior cases by score desc. Greedy pack: stop at the first
 * item that would push the running total over `budgetTokens`; everything
 * after it is dropped and `truncated` is set.
 */
export function buildContextBundle(
  input: ContextBuildInput,
  budgetTokens: number = DEFAULT_CONTEXT_BUDGET_TOKENS,
): ContextBundle {
  const items: ContextBundleItem[] = [];

  // 1. Pattern block — one item, highest priority (smallest, defines the
  //    hypothesis space the rest of the bundle is evidence about).
  for (const p of input.patterns) {
    const text = renderPatternBlock(p);
    items.push({
      id: `pattern:${p.pattern_id}`,
      kind: "pattern",
      text,
      source_doc: p.name,
      token_count: approxTokenCount(text),
      score: 1,
    });
  }

  // 2. Agent evidence — already curated, keep caller order.
  for (const e of input.evidenceItems ?? []) {
    const text = `[${e.category}] ${e.summary}`;
    items.push({
      id: e.id,
      kind: "evidence",
      text,
      source_doc: "evidence",
      token_count: approxTokenCount(text),
      score: 0.9,
    });
  }

  // 3. Policy chunks — rank by vector score.
  const rankedChunks = [...input.policyChunks].sort((a, b) => b.score - a.score);
  for (const c of rankedChunks) {
    const prefix = c.heading_path ? `[policy] ${c.source_doc} (${c.heading_path})` : `[policy] ${c.source_doc}`;
    const text = `${prefix}\n${c.text}`;
    items.push({
      id: c.id,
      kind: "policy_chunk",
      text,
      source_doc: c.source_doc,
      token_count: approxTokenCount(text),
      score: c.score,
    });
  }

  // 4. Prior cases — rank by combined cosine+overlap score.
  const rankedCases = [...input.priorCases].sort((a, b) => b.score - a.score);
  for (const c of rankedCases) {
    const text = `[prior case] ${c.id} (${c.outcome}) — why similar: ${c.overlap_reason}\n${c.summary_text}`;
    items.push({
      id: c.id,
      kind: "prior_case",
      text,
      source_doc: "closed-case memory",
      token_count: approxTokenCount(text),
      score: c.score,
    });
  }

  // Greedy budget pack.
  const included: ContextBundleItem[] = [];
  let total = 0;
  let dropped = 0;
  for (const item of items) {
    if (total + item.token_count > budgetTokens) {
      dropped++;
      continue;
    }
    included.push(item);
    total += item.token_count;
  }

  return {
    items: included,
    total_tokens: total,
    budget_tokens: budgetTokens,
    truncated: dropped > 0,
    provenance_ids: included.map((i) => i.id),
  };
}