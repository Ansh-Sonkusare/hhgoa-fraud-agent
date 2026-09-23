import type {
  Assessment,
  EvidenceItem,
  NextBestAction,
  PolicyActionName,
  Verdict,
} from "@hhgoa/contracts";
import { policyCheck } from "@hhgoa/policy";
import type { InvestigationFacts } from "./investigation.js";
import { buildCaseStateForPolicy } from "./caseState.js";
import { assessSharedOrigin } from "./sharedOrigin.js";
import { describeProxyDeviceRing } from "./evidenceBuilder.js";
import { resolvePatternLabel, topFraudHypothesis, fraudProbability, CONTRADICTION_WEIGHT_THRESHOLD } from "./assess.js";
import { sarRequired } from "@hhgoa/policy";
import { independentFraudSignals } from "./singleSignal.js";

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

/**
 * R8's second trigger, "or the evidence conflicts": the record disagrees about
 * the call being made. That means material evidence both supports and
 * contradicts the *leading* pattern, or material evidence supports fraud while
 * material evidence supports legitimate.
 *
 * It used to fire when any label at any weight was both supported and
 * contradicted anywhere in the record. Differential evidence always does that
 * for the patterns being ruled out -- the channel claim contradicts the other
 * family while a weak region item supports one of them -- so every uncertain
 * case escalated, including all three cleared cases in the 20-case sample.
 * The dataset's 900 cleared cases were each closed with
 * VERIFY_WITH_CUSTOMER|CLOSE_NO_FRAUD on a single signal the cardholder then
 * confirmed; that is R1's verify, not an escalation. "Material" is the same
 * weight line the confidence guard uses (CONTRADICTION_WEIGHT_THRESHOLD).
 */
function conflictingLabels(evidence: EvidenceItem[], leading: string | null): string[] {
  const material = evidence.filter((e) => e.weight_hint >= CONTRADICTION_WEIGHT_THRESHOLD);
  const supported = (label: string) => material.some((e) => e.supports.includes(label));
  const contradicted = (label: string) => material.some((e) => e.contradicts.includes(label));
  if (leading !== null && supported(leading) && contradicted(leading)) return [leading];
  const fraudSupported = material.some((e) => e.supports.some((s) => s !== "legitimate"));
  if (fraudSupported && supported("legitimate")) return ["fraud vs legitimate"];
  return [];
}

function describeConflict(evidence: EvidenceItem[], leading: string | null): string {
  const labels = conflictingLabels(evidence, leading);
  return `material evidence both supports and contradicts ${labels.join(", ")}`;
}

export function recommendActions(
  facts: InvestigationFacts,
  assessment: Assessment,
  evidence: EvidenceItem[],
  verdict: Verdict,
): Recommendations {
  const cs = buildCaseStateForPolicy(facts, assessment, evidence);
  const topFraud = topFraudHypothesis(assessment);
  // Same source of truth as the filed answer: with no fraud hypothesis this
  // is 1 - P(legitimate), not 0, so actions cannot disagree with the verdict.
  const fraudProb = fraudProbability(assessment);
  const pattern = resolvePatternLabel(assessment, Boolean(facts.proxy_device_ring));
  const why: Record<PolicyActionName, string> = {} as Record<PolicyActionName, string>;

  const check = (action: PolicyActionName) => policyCheck(action, cs);

  const cands: NextBestAction[] = [];
  const add = (action: PolicyActionName, reason: string) => {
    // R9 below can name an action a branch already added; keep the first.
    if (cands.some((c) => c.action === action)) return;
    const pc = check(action);
    if (!pc.allowed) return;
    why[action] = reason;
    cands.push({ action, route: pc.approval_route, reason });
  };

  const exposure = facts.exposure_usd;
  const leading = topFraud?.fraud_type ?? null;
  const conflicted = conflictingLabels(evidence, leading).length > 0;
  const shared = cs.shared_origin_connection;
  const sharedOrigin = assessSharedOrigin(facts);
  const coordinated = cs.coordinated_or_undocumented;
  // R9's action triple is for abuse "across customers" (DATASET_README R9).
  // The single-card amount-structuring burst is still `undocumented` -- and
  // §3a's report test counts an undocumented pattern -- but it is not
  // cross-customer, so it takes the ordinary R2/§3a path.
  const crossCustomer =
    Boolean(facts.proxy_device_ring) || facts.patterns.some((p) => p.pattern_id === "coordinated");
  const sar = sarRequired(cs);
  const sarGround = shared
    ? sharedOrigin.reason
    : coordinated
      ? "the pattern is undocumented (§3a)"
      : `exposure ${money(exposure)} exceeds $1,000 (§3a)`;

  if (facts.dispute_recurring) {
    // R7: disputed but legitimate. The charge repeats the card's own monthly
    // pattern, so verify and remind -- never block.
    add("CREATE_CASE", `R7 / §3a: the customer disputed a charge, and every dispute opens a case`);
    add("VERIFY_WITH_CUSTOMER", `R7: the disputed charge repeats this card's own monthly charge (same amount and product code); confirm with the customer rather than block`);
    add("WARN_CUSTOMER", `R7: remind the customer of the recurring charge they appear to have forgotten`);
  } else if (pattern === "none" && fraudProb < 0.5 && !cs.customer_denied) {
    // A disputed charge never reaches this branch: R2 governs a denial even
    // when no fraud pattern is named, and allowing a charge the cardholder
    // says they never made would contradict it.
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
      add("MONITOR_CONNECTED_CARDS", `R6: ${sharedOrigin.reason}; connected card(s) ${facts.connected_card_ids.join(", ")}`);
    }
    if (sar && !crossCustomer) {
      add("FILE_REPORT", `§3a: fraud strongly suspected and ${sarGround}; a report is required`);
    }
    if (cs.confirmed_fraud_card_count >= 2) {
      add("BLOCK_ALL_CARDS", `R10: two of the customer's cards show confirmed fraud`);
    }
  } else if (fraudProb >= 0.4) {
    // Uncertain but material → R1 verification before any enforcement.
    // Say what the case actually rests on: the old text claimed "no
    // corroborating device or prior-case evidence" even when both had been
    // gathered and simply did not count as independent fraud signals.
    const signals = independentFraudSignals(evidence);
    const basis =
      signals.length === 0
        ? "no independent fraud signal"
        : signals.length === 1
          ? `a single independent signal (${signals[0]})`
          : `${signals.length} signals (${signals.join(", ")}) that together stay below the 0.70 block line`;
    if (facts.verification_unanswered) {
      // README §3b: recommend, ask, recommend again. The cardholder was asked
      // under R1 and no reply came back, so R4 ("no reply") governs now. R4's
      // DECLINE_TRANSACTION is for *pending* authorizations, and the dataset
      // records no authorization status to find one by, so none is invented.
      add(
        "MONITOR_CARD",
        `R4: the cardholder has not replied to the R1 verification request; keep the card active under 72-hour monitoring (the data records no pending authorization to decline)`,
      );
    } else {
      add("VERIFY_WITH_CUSTOMER", `R1: fraud probability ${fraudProb.toFixed(2)} rests on ${basis}; verify before any block`);
      add("MONITOR_CARD", `Precautionary monitoring while awaiting the customer's response (R4)`);
    }
    // §3a: "Open one whenever fraud probability reaches 0.30, whenever you
    // request evidence". Every case in this band does both.
    add("CREATE_CASE", `§3a: fraud probability ${fraudProb.toFixed(2)} reached 0.30 and verification is requested; open a case`);
    // R8 is scoped to an *uncertain verdict*, not to a probability band. A
    // cardholder who confirms the charge settles the case as legitimate even
    // at p=0.45, and escalating it anyway contradicts the answer we file —
    // HHG-006 shipped "R8: uncertain with exposure $1906.07" on a case it
    // declared legitimate with $0 exposure.
    if (verdict === "uncertain") {
      if (exposure > 500) {
        add(
          "ESCALATE_TO_ANALYST",
          facts.verification_unanswered
            ? `R4 and R8: no reply, uncertain, and exposure ${money(exposure)} > $500 — escalate to an analyst`
            : `R8: uncertain with exposure ${money(exposure)} > $500 — escalate to an analyst`,
        );
      } else if (conflicted) {
        add("ESCALATE_TO_ANALYST", `R8: uncertain and the evidence conflicts (${describeConflict(evidence, leading)}) — escalate to an analyst`);
      }
    }
  } else {
    // Low conviction, low probability.
    add("MONITOR_CARD", `Fraud probability ${fraudProb.toFixed(2)} is low; keep monitoring (R4)`);
    if (fraudProb >= 0.3) {
      add("CREATE_CASE", `§3a: fraud probability ${fraudProb.toFixed(2)} reached 0.30; open a case`);
    }
    if (verdict === "uncertain" && exposure > 500) {
      add("ESCALATE_TO_ANALYST", `R8: uncertain with exposure ${money(exposure)} > $500 — escalate to an analyst`);
    }
  }

  // R9 carries no probability condition: coordinated abuse across customers
  // is opened, reported and escalated whatever this case's own probability
  // says. FILE_REPORT still passes through policy, which files a report only
  // when fraud is confirmed or strongly suspected (DATASET_README line 257);
  // below that bar the case is still opened and put in front of an analyst.
  // A case we are clearing, or a recognised recurring charge (R7), is not
  // coordinated abuse whatever its device looks like.
  if (crossCustomer && verdict !== "legitimate" && !facts.dispute_recurring) {
    const what = facts.proxy_device_ring
      ? describeProxyDeviceRing(facts.proxy_device_ring)
      : "a detector reported coordinated activity across customers";
    // R9's reason for the case is the specific one; replace §3a's generic line.
    const generic = cands.findIndex((c) => c.action === "CREATE_CASE");
    if (generic >= 0) cands.splice(generic, 1);
    add("CREATE_CASE", `R9: ${what}`);
    add("FILE_REPORT", `R9: coordinated/undocumented pattern; report regardless of exposure`);
    add("ESCALATE_TO_ANALYST", `R9: coordinated abuse across customers needs an analyst`);
  }

  const actions = cands.sort(
    (a, b) =>
      ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action),
  );

  // The intended action is the decision itself. CREATE_CASE is bookkeeping
  // that §3a attaches to most cases, and it sorts early, so taking it would
  // point the evidence planner and the stop rule at the wrong action.
  const intendedAction = actions.find((a) => a.action !== "CREATE_CASE") ?? actions[0] ?? null;
  const intendedActionAllowed = intendedAction ? check(intendedAction.action).allowed : true;

  return { actions, intendedAction, intendedActionAllowed, why };
}

/** Human summary of what changed between two recommendation snapshots. */
export function summarizeChange(
  initial: NextBestAction[],
  current: NextBestAction[],
  assessment: Assessment,
  facts: InvestigationFacts,
  requests: ReadonlyArray<{ type: string }> = [],
): string {
  const key = (a: NextBestAction) => `${a.action}:${a.route}`;
  const same = initial.length === current.length && initial.every((a) => current.some((b) => key(b) === key(a)));
  const asked = [...new Set(requests.map((r) => r.type.replace(/_/g, " ")))];
  if (same) {
    // docs/DATASET_README.md line 356: with nothing requested, final equals
    // initial and what_changed is "nothing". When evidence *was* requested,
    // line 450 wants final to reflect the assumed response -- here, that no
    // reply came back -- so say that instead of a bare "nothing".
    if (asked.length === 0) return "nothing";
    return `Requested ${asked.join(" and ")}; no reply was received and none was assumed, so the recommendation is unchanged and verification remains outstanding.`;
  }
  const names = (xs: NextBestAction[]) => new Set(xs.map((a) => a.action));
  const before = names(initial);
  const after = names(current);
  const added = [...after].filter((a) => !before.has(a)).sort();
  const dropped = [...before].filter((a) => !after.has(a)).sort();
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.join(", ")}`);
  if (dropped.length > 0) parts.push(`dropped ${dropped.join(", ")}`);
  if (parts.length === 0) parts.push("changed approval routes");
  const prob = fraudProbability(assessment).toFixed(2);
  if (facts.verification_unanswered) {
    return (
      `Asked the cardholder to verify under R1 (${asked.join(" and ")}); no reply was received and none was assumed, ` +
      `so R4 ("no reply") now governs at fraud probability ${prob}: ${parts.join("; ")}. Verification remains outstanding.`
    );
  }
  const lead = asked.length > 0 ? `After requesting ${asked.join(" and ")} (no reply received)` : "As further graph evidence came in";
  return `${lead}, fraud probability stands at ${prob}; ${parts.join("; ")}.`;
}
