import type {
  Assessment,
  EvidenceItem,
  NextBestAction,
  PolicyActionName,
} from "@hhgoa/contracts";
import { policyCheck } from "@hhgoa/policy";
import type { InvestigationFacts } from "./investigation.js";
import { buildCaseStateForPolicy } from "./caseState.js";
import { canonicalPattern, topFraudHypothesis } from "./assess.js";
import { sarRequired } from "@hhgoa/policy";

/**
 * Recommender (PRD §9.4/§9.5): the deterministic next-best-actions list the
 * machine actually acts on. Each candidate action is routed through the
 * WS5 policy engine (`policyCheck`) so `route` and `allowed` can never
 * disagree with the engine that will later execute it (PRD §10.5
 * guarantee 1). Rule citations (R1–R10, §3a) mirror README Fraud Policy.
 */

/** Recommendation presentation order (severity first). */
export const ACTION_ORDER: readonly PolicyActionName[] = [
  "BLOCK_ALL_CARDS",
  "BLOCK_CARD",
  "DECLINE_TRANSACTION",
  "CREATE_CASE",
  "FILE_REPORT",
  "MONITOR_CONNECTED_CARDS",
  "ESCALATE_TO_ANALYST",
  "STEP_UP_AUTH",
  "VERIFY_WITH_CUSTOMER",
  "MONITOR_CARD",
  "WARN_CUSTOMER",
  "GENERATE_REPORT",
  "ALLOW_TRANSACTION",
  "CLOSE_NO_FRAUD",
];

export interface Recommendations {
  /** Priority-sorted, policy-checked actions. */
  actions: NextBestAction[];
  /** The most severe action (what the agent would do now). */
  intendedAction: NextBestAction | null;
  /** policy_check of the intended action. */
  intendedActionAllowed: boolean;
  why: Record<PolicyActionName, string>;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function recommendActions(
  facts: InvestigationFacts,
  assessment: Assessment,
  evidence: EvidenceItem[],
): Recommendations {
  const cs = buildCaseStateForPolicy(facts, assessment, evidence);
  const topFraud = topFraudHypothesis(assessment);
  const fraudProb = topFraud?.probability ?? 0;
  const pattern = canonicalPattern(topFraud?.fraud_type ?? null);
  const why: Record<PolicyActionName, string> = {} as Record<PolicyActionName, string>;

  const check = (action: PolicyActionName) => policyCheck(action, cs);

  const cands: NextBestAction[] = [];
  const add = (action: PolicyActionName, reason: string) => {
    const pc = check(action);
    if (!pc.allowed) return;
    why[action] = reason;
    cands.push({ action, route: pc.approval_route, reason });
  };

  const exposure = facts.exposure_usd;
  const shared = cs.shared_origin_connection;
  const coordinated = cs.coordinated_or_undocumented;
  const sar = sarRequired(cs);

  if (pattern === "none" && fraudProb < 0.5) {
    // Legitimate / not suspicious → allow + close (R3).
    if (exposure > 0) {
      add("ALLOW_TRANSACTION", `R3: cardholder activity consistent with legitimate use; allow the flagged transaction`);
    }
    add("CLOSE_NO_FRAUD", `R3: no fraud indicated; customer records support legitimate activity`);
  } else if (fraudProb >= 0.7 || cs.customer_denied) {
    // High conviction OR customer denial → enforce.
    const largestCleared = facts.txn_rows.reduce((m, r) => Math.max(m, r.amount_usd), 0);
    if (pattern === "card_testing" && largestCleared >= 100) {
      add("BLOCK_CARD", `R5: card-testing sequence with an ${money(largestCleared)} purchase already cleared; exposure ${money(exposure)}`);
    } else {
      add("BLOCK_CARD", `R2: customer denied the transaction(s) or fraud probability ${fraudProb.toFixed(2)} exceeds the 0.70 block threshold; exposure ${money(exposure)}`);
    }
    add("CREATE_CASE", `R6 / §3a: fraud probability reached 0.30 and a case must be opened`);
    if (shared) {
      add("MONITOR_CONNECTED_CARDS", `R6: same device profile also used on ${facts.connected_card_ids.join(", ")}`);
    }
    if (coordinated) {
      add("FILE_REPORT", `R9: coordinated/undocumented pattern (undocumented or multi-card); report regardless of exposure`);
    }
    if (sar && !coordinated) {
      add("FILE_REPORT", `R6: shared device profile links this to other card fraud; a report is required regardless of exposure`);
    }
    if (cs.confirmed_fraud_card_count >= 2) {
      add("BLOCK_ALL_CARDS", `R10: two of the customer's cards show confirmed fraud`);
    }
  } else if (fraudProb >= 0.4) {
    // Uncertain but material → R1 verification before any enforcement.
    add("VERIFY_WITH_CUSTOMER", `R1: probability ${fraudProb.toFixed(2)} rests on a ${facts.patterns.length < 2 ? "single ambiguous signal" : "weak signal"} with no corroborating device or prior-case evidence; verify before any block`);
    add("MONITOR_CARD", `Precautionary monitoring while awaiting the customer's response (R4)`);
    if (exposure > 500) {
      add("ESCALATE_TO_ANALYST", `R8: uncertain with exposure ${money(exposure)} > $500 — escalate to an analyst`);
    }
  } else {
    // Low conviction, low probability.
    add("MONITOR_CARD", `Fraud probability ${fraudProb.toFixed(2)} is low; keep monitoring (R4)`);
    if (exposure > 500) {
      add("ESCALATE_TO_ANALYST", `R8: uncertain with exposure ${money(exposure)} > $500`);
    }
  }

  const actions = cands.sort(
    (a, b) =>
      ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action),
  );

  const intendedAction = actions[0] ?? null;
  const intendedActionAllowed = intendedAction ? check(intendedAction.action).allowed : true;

  return { actions, intendedAction, intendedActionAllowed, why };
}

/** Human summary of what changed between two recommendation snapshots. */
export function summarizeChange(
  initial: NextBestAction[],
  current: NextBestAction[],
  assessment: Assessment,
  facts: InvestigationFacts,
): string {
  const key = (a: NextBestAction) => `${a.action}:${a.route}`;
  const same = initial.length === current.length && initial.every((a) => current.some((b) => key(b) === key(a)));
  if (same) return "nothing";
  const after = current
    .map((a) => a.action)
    .sort()
    .join(", ");
  const before = initial
    .map((a) => a.action)
    .sort()
    .join(", ");
  return `Recommended actions changed from [${before}] to [${after}] as evidence came in.`;
}