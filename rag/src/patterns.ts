import type { PatternRecord } from "./types.js";

/**
 * Local `Pattern` nodes with their `REQUIRES_EVIDENCE`/permitted-action
 * links (PRD §7: `Pattern`, `Pattern -REQUIRES_EVIDENCE-> EvidenceType`).
 * This is the "graph expansion" target for `retrieve_policy`'s hybrid
 * retrieval (PRD §11 step 2) until WS1's real graph exists — see
 * `rag/src/store/vectorStore.ts` header and `docs/REQUESTS.md`.
 *
 * Every `required_evidence` id and `permitted_actions` entry here is
 * derived directly from docs/DATASET_README.md's "The five known fraud
 * patterns" and "Fraud Policy" sections (rule numbers cited in `rule_refs`)
 * — nothing invented. `permitted_actions` values are exact `PolicyActionNameSchema`
 * identifiers (`contracts/src/answerFile.ts`) so `retrieve_policy`'s output
 * can be used directly by the agent's evidence/action planning without
 * re-mapping.
 */
export const PATTERNS: PatternRecord[] = [
  {
    pattern_id: "card_testing",
    name: "Card testing",
    kind: "documented",
    required_evidence: [
      "txn_velocity_small_online_auths", // ">=3 tiny online auths, often <$5"
      "larger_purchase_follows_sequence", // "then a larger purchase"
    ],
    permitted_actions: ["DECLINE_TRANSACTION", "STEP_UP_AUTH", "BLOCK_CARD"],
    rule_refs: ["R5"],
  },
  {
    pattern_id: "card_not_present_fraud",
    name: "Card-not-present fraud",
    kind: "documented",
    required_evidence: [
      "baseline_deviation_amount_or_product", // "amounts/products that don't fit cardholder history"
      "txn_burst_within_48h", // "burst of two to four within 48 hours"
    ],
    permitted_actions: [
      "VERIFY_WITH_CUSTOMER",
      "STEP_UP_AUTH",
      "BLOCK_CARD",
      "CREATE_CASE",
      "CLOSE_NO_FRAUD",
      "MONITOR_CARD",
      "DECLINE_TRANSACTION",
      "ESCALATE_TO_ANALYST",
    ],
    rule_refs: ["R1", "R2", "R3", "R4"],
  },
  {
    pattern_id: "card_not_present_new_device",
    name: "Card-not-present fraud from a new device",
    kind: "documented",
    required_evidence: [
      "baseline_deviation_amount_or_product",
      "txn_burst_within_48h",
      "identity_device_marked_new", // id_15 == "New"
      "identity_proxy_flag", // id_23, "sometimes behind a proxy"
    ],
    permitted_actions: [
      "VERIFY_WITH_CUSTOMER",
      "STEP_UP_AUTH",
      "BLOCK_CARD",
      "CREATE_CASE",
      "CLOSE_NO_FRAUD",
      "MONITOR_CONNECTED_CARDS",
      "FILE_REPORT",
    ],
    rule_refs: ["R1", "R2", "R3", "R4", "R6"],
  },
  {
    pattern_id: "out_of_region_use",
    name: "Out-of-region use",
    kind: "documented",
    required_evidence: [
      "billing_region_no_prior_history", // addr1 with no cardholder history
      "concurrent_home_region_activity", // "normal activity continues at home"
    ],
    permitted_actions: [
      "VERIFY_WITH_CUSTOMER",
      "BLOCK_CARD",
      "CREATE_CASE",
      "CLOSE_NO_FRAUD",
      "MONITOR_CARD",
    ],
    rule_refs: ["R2", "R3"],
  },
  {
    pattern_id: "account_takeover",
    name: "Account takeover",
    kind: "documented",
    required_evidence: [
      "mixed_channel_activity_inconsistent_with_cardholder",
      "device_or_match_flag_anomaly", // M1-M9, id_30/31/33/34
    ],
    permitted_actions: [
      "BLOCK_CARD",
      "BLOCK_ALL_CARDS",
      "CREATE_CASE",
      "FILE_REPORT",
      "ESCALATE_TO_ANALYST",
      "STEP_UP_AUTH",
    ],
    // R10 gates BLOCK_ALL_CARDS specifically; R8 covers the uncertain+exposed case.
    rule_refs: ["R8", "R10"],
  },
  {
    pattern_id: "undocumented",
    name: "Undocumented pattern",
    kind: "documented", // the *category* is documented in policy (R9); the specific pattern instance is discovered
    required_evidence: [
      "coordinated_or_repeated_abuse_across_customers",
    ],
    permitted_actions: ["CREATE_CASE", "FILE_REPORT", "ESCALATE_TO_ANALYST"],
    rule_refs: ["R9"],
  },
];

export function findPattern(pattern_id: string): PatternRecord | undefined {
  return PATTERNS.find((p) => p.pattern_id === pattern_id);
}
