import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ToolResult, ToolVia } from "./toolEnvelope.js";
import type { ToolCatalog } from "./tools.js";

/**
 * In-memory fake implementations of every tool in `ToolCatalog` (PRD §8.6).
 * Each fake returns a `ToolResult` envelope wrapping the JSON fixture at
 * `contracts/examples/<tool_name>.json`. Switch via `TOOLS_BACKEND=fake|real`
 * in the (future) agent tool registry — this module is the `fake` side.
 */

const examplesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples",
);

function loadExample<T>(name: string): T {
  const file = path.join(examplesDir, `${name}.json`);
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function envelope<T>(
  tool: string,
  as_of: string,
  via: ToolVia,
  data: T,
): ToolResult<T> {
  return {
    ok: true,
    tool,
    as_of,
    via,
    data,
    evidence_refs: [],
    truncated: false,
    latency_ms: 1,
    error: null,
  };
}

/** Tools that carry no `as_of` (not graph/RAG/memory reads — PRD §8.1) use this. */
const NO_AS_OF = "n/a";

export const fakes: ToolCatalog = {
  resolve_trigger: async (_trigger, as_of) =>
    envelope("resolve_trigger", as_of, "mcp", loadExample("resolve_trigger")),

  get_entity_profile: async (_entity, as_of) =>
    envelope(
      "get_entity_profile",
      as_of,
      "mcp",
      loadExample("get_entity_profile"),
    ),

  get_transaction_history: async (_entity, _window, as_of) =>
    envelope(
      "get_transaction_history",
      as_of,
      "mcp",
      loadExample("get_transaction_history"),
    ),

  get_neighborhood: async (_entity, _hops, _filters, as_of) =>
    envelope("get_neighborhood", as_of, "mcp", loadExample("get_neighborhood")),

  compute_velocity: async (_entity, _window_minutes, as_of) =>
    envelope("compute_velocity", as_of, "mcp", loadExample("compute_velocity")),

  find_shared_entity_rings: async (_entity, as_of) =>
    envelope(
      "find_shared_entity_rings",
      as_of,
      "mcp",
      loadExample("find_shared_entity_rings"),
    ),

  get_baseline_deviation: async (_txn, as_of) =>
    envelope(
      "get_baseline_deviation",
      as_of,
      "mcp",
      loadExample("get_baseline_deviation"),
    ),

  detect_patterns: async (_entity_or_txn, as_of) =>
    envelope("detect_patterns", as_of, "mcp", loadExample("detect_patterns")),

  get_community: async (_entity, as_of) =>
    envelope("get_community", as_of, "mcp", loadExample("get_community")),

  find_prior_cases: async (_entity, as_of) =>
    envelope("find_prior_cases", as_of, "mcp", loadExample("find_prior_cases")),

  get_wide_features: async (_txn_ids) =>
    envelope(
      "get_wide_features",
      NO_AS_OF,
      "local",
      loadExample("get_wide_features"),
    ),

  retrieve_policy: async (_query, _pattern_id, _k) =>
    envelope("retrieve_policy", NO_AS_OF, "rag", loadExample("retrieve_policy")),

  retrieve_similar_cases: async (_fingerprint, as_of, _k) =>
    envelope(
      "retrieve_similar_cases",
      as_of,
      "rag",
      loadExample("retrieve_similar_cases"),
    ),

  lookup_external: async (_kind, _value) =>
    envelope(
      "lookup_external",
      NO_AS_OF,
      "local",
      loadExample("lookup_external"),
    ),

  case_open: async (_trigger, as_of) =>
    envelope("case_open", as_of, "local", loadExample("case_open")),

  case_add_evidence: async (_case_id, _evidence, as_of) =>
    envelope("case_add_evidence", as_of, "local", loadExample("case_add_evidence")),

  case_add_finding: async (_case_id, _finding, as_of) =>
    envelope("case_add_finding", as_of, "local", loadExample("case_add_finding")),

  case_update_assessment: async (_case_id, _assessment, as_of) =>
    envelope(
      "case_update_assessment",
      as_of,
      "local",
      loadExample("case_update_assessment"),
    ),

  case_record_decision: async (_case_id, _decision, as_of) =>
    envelope(
      "case_record_decision",
      as_of,
      "local",
      loadExample("case_record_decision"),
    ),

  case_record_action: async (_case_id, _action, _status, as_of) =>
    envelope(
      "case_record_action",
      as_of,
      "local",
      loadExample("case_record_action"),
    ),

  case_set_status: async (_case_id, _status, as_of) =>
    envelope("case_set_status", as_of, "local", loadExample("case_set_status")),

  case_close: async (_case_id, as_of) =>
    envelope("case_close", as_of, "local", loadExample("case_close")),

  policy_check: async (_input) =>
    envelope("policy_check", NO_AS_OF, "policy", loadExample("policy_check")),

  execute_action: async (_input) =>
    envelope("execute_action", NO_AS_OF, "policy", loadExample("execute_action")),

  request_evidence: async (_input) =>
    envelope(
      "request_evidence",
      NO_AS_OF,
      "policy",
      loadExample("request_evidence"),
    ),

  generate_sar: async (_case_id) =>
    envelope("generate_sar", NO_AS_OF, "policy", loadExample("generate_sar")),
};
