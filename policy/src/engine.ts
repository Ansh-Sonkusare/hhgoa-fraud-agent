import type {
  ApprovalChannel,
  ApprovalRoute,
  EvidenceResponder,
  EvidenceRequestInput,
  EvidenceResponse,
  ExecuteActionResult,
  PolicyCheckResult,
} from "@hhgoa/contracts";
import { getPolicyConfig } from "./loadPolicy.js";
import type { CaseStateForPolicy, ExecuteActionParams, PolicyActionName } from "./types.js";
import type { ActionsMock } from "./actionsMock.js";

/**
 * Policy engine (PRD §10, §10.5). This is the ONLY place that decides
 * whether an action is allowed, what its approval route is, and whether a
 * SAR is required. `execute_action` (below) is the only path to a side
 * effect and always calls `policyCheck` first (PRD §10.5 hard guarantee 1).
 */

function getActionConfig(action: string) {
  const cfg = getPolicyConfig().actions[action];
  if (!cfg) {
    throw new Error(`policy: unknown action "${action}" — not in policy.yaml`);
  }
  return cfg;
}

/**
 * BLOCK_CARD's approval route depends on exposure (README Fraud Policy §2:
 * "L1 when exposure <= $2,500, L2 when exposure > $2,500"). Every other
 * action's route is the flat value in policy.yaml. See policy.yaml's
 * comment on BLOCK_CARD for why this can't be a plain YAML scalar.
 */
export function computeApprovalRoute(
  action: PolicyActionName,
  cs: CaseStateForPolicy,
): ApprovalRoute | "none" {
  const cfg = getActionConfig(action);
  if (action === "BLOCK_CARD") {
    const threshold =
      typeof cfg.prerequisites?.exposure_l2_above_usd === "number"
        ? cfg.prerequisites.exposure_l2_above_usd
        : 2500;
    return cs.exposure_usd > threshold ? "L2" : "L1";
  }
  return cfg.approval_route;
}

/** The subset of case state README §3a's SAR test actually reads. */
export type SarInputState = Pick<
  CaseStateForPolicy,
  "fraud_confirmed_or_strongly_suspected" | "exposure_usd" | "shared_origin_connection" | "coordinated_or_undocumented"
>;

/** README §3a's SAR test, structured. */
export function sarRequired(cs: SarInputState): boolean {
  if (!cs.fraud_confirmed_or_strongly_suspected) return false;
  return (
    cs.exposure_usd > 1000 || cs.shared_origin_connection || cs.coordinated_or_undocumented
  );
}

/** Returns human-readable missing-prerequisite reasons; empty means allowed. */
export function checkPrerequisites(action: PolicyActionName, cs: CaseStateForPolicy): string[] {
  const missing: string[] = [];
  switch (action) {
    case "DECLINE_TRANSACTION":
    case "BLOCK_CARD": {
      const cfg = getActionConfig(action);
      const minProb =
        typeof cfg.prerequisites?.min_probability_unless_customer_denied === "number"
          ? cfg.prerequisites.min_probability_unless_customer_denied
          : 0.7;
      // R1 asks for verification *before* a block on a weak signal. Once the
      // cardholder was asked and did not reply, that step is done and R4 calls
      // for DECLINE_TRANSACTION on the flagged authorization; a BLOCK_CARD
      // still needs 0.70 or a denial (R4 does not block).
      const verifiedFirst = action === "DECLINE_TRANSACTION" && cs.verification_unanswered === true;
      if (cs.fraud_probability < minProb && !cs.customer_denied && !verifiedFirst) {
        missing.push(
          `R1: fraud_probability ${cs.fraud_probability.toFixed(2)} is below ${minProb} and the customer has not denied the transaction — VERIFY_WITH_CUSTOMER or STEP_UP_AUTH must come first`,
        );
      }
      break;
    }
    case "BLOCK_ALL_CARDS": {
      const cfg = getActionConfig(action);
      const minCards =
        typeof cfg.prerequisites?.min_confirmed_fraud_cards === "number"
          ? cfg.prerequisites.min_confirmed_fraud_cards
          : 2;
      if (cs.confirmed_fraud_card_count < minCards && !cs.credentials_confirmed_compromised) {
        missing.push(
          `R10: only ${cs.confirmed_fraud_card_count} of the customer's cards show confirmed fraud (need ${minCards}) and credentials are not confirmed compromised`,
        );
      }
      break;
    }
    case "FILE_REPORT": {
      if (!sarRequired(cs)) {
        missing.push(
          "§3a: SAR conditions not met — fraud is not confirmed/strongly suspected, or none of exposure > $1,000, a shared-origin connection, or a coordinated/undocumented pattern (R9) hold",
        );
      }
      break;
    }
    default:
      break;
  }
  return missing;
}

/**
 * The single gate for both actions (from `policy.yaml#actions`) and
 * evidence requests (from `policy.yaml#evidence_requests`). Matches the
 * `PolicyCheck` tool signature in `contracts/src/tools.ts` once curried by
 * `toolAdapters.ts`.
 */
export function policyCheck(actionOrRequest: string, cs: CaseStateForPolicy): PolicyCheckResult {
  const cfg = getPolicyConfig();

  if (actionOrRequest in cfg.actions) {
    const action = actionOrRequest as PolicyActionName;
    const missing = checkPrerequisites(action, cs);
    const route = computeApprovalRoute(action, cs);
    return {
      allowed: missing.length === 0,
      approval_route: route === "none" ? "auto" : route,
      missing_prerequisites: missing,
      sar_required: sarRequired(cs),
    };
  }

  if (actionOrRequest in cfg.evidence_requests) {
    const req = cfg.evidence_requests[actionOrRequest];
    if (!req) throw new Error(`unreachable: ${actionOrRequest} checked present above`);
    return {
      allowed: true,
      approval_route: req.approval_route === "none" ? "auto" : req.approval_route,
      missing_prerequisites: [],
      sar_required: sarRequired(cs),
    };
  }

  return {
    allowed: false,
    approval_route: "auto",
    missing_prerequisites: [`unknown action_or_request "${actionOrRequest}" — not in policy.yaml`],
    sar_required: false,
  };
}

export interface ExecuteActionDeps {
  approvalChannel: ApprovalChannel;
  actionsMock: ActionsMock;
}

export interface ExecuteActionOutcome {
  result: ExecuteActionResult;
  reason?: string;
}

/**
 * PRD §10.5 hard guarantees:
 *  1. This is the only path to a side effect, and it always calls
 *     `policyCheck` first.
 *  2. `executable_by_agent: false` actions can only ever reach
 *     PENDING_APPROVAL (never EXECUTED) without a channel decision.
 *  3. Missing prerequisites -> DENIED, with the reason surfaced.
 */
export async function executeAction(
  action: PolicyActionName,
  params: ExecuteActionParams,
  deps: ExecuteActionDeps,
): Promise<ExecuteActionOutcome> {
  const check = policyCheck(action, params.case_state);
  if (!check.allowed) {
    return { result: "DENIED", reason: check.missing_prerequisites.join("; ") };
  }

  const cfg = getActionConfig(action);

  if (cfg.executable_by_agent && check.approval_route === "auto") {
    await deps.actionsMock.run(action, params);
    return { result: "EXECUTED" };
  }

  // executable_by_agent is false (or, defensively, the route isn't "auto"
  // even though the action is agent-executable): route through the human
  // approval channel. The channel may already hold a recorded decision
  // (e.g. a human approved via the UI earlier) — if not, it returns
  // "pending" and we surface PENDING_APPROVAL, never EXECUTED.
  const decision = await deps.approvalChannel.requestApproval({
    case_id: params.case_state.case_id,
    action,
    route: check.approval_route,
    reason: params.reason,
  });

  if (decision === "approved") {
    await deps.actionsMock.run(action, params);
    return { result: "EXECUTED" };
  }
  if (decision === "rejected") {
    return { result: "DENIED", reason: "rejected by approver" };
  }
  return { result: "PENDING_APPROVAL" };
}

export interface RequestEvidenceDeps {
  responder: EvidenceResponder;
}

/**
 * README §5: the agent may, without approval, request these three evidence
 * types. Still goes through `policyCheck` first (same gate as actions) so
 * an unknown/misspelled request type fails loudly instead of silently
 * calling the responder.
 */
export async function requestEvidence(
  input: EvidenceRequestInput,
  cs: CaseStateForPolicy,
  deps: RequestEvidenceDeps,
): Promise<EvidenceResponse> {
  const check = policyCheck(input.type, cs);
  if (!check.allowed) {
    throw new Error(`request_evidence denied: ${check.missing_prerequisites.join("; ")}`);
  }
  if (check.approval_route !== "auto") {
    // Not reachable with the current policy.yaml (all three evidence
    // requests are approval_route: none) but guarded defensively in case
    // that ever changes.
    throw new Error(
      `request_evidence "${input.type}" requires approval route ${check.approval_route}; synchronous responders only support auto`,
    );
  }
  return deps.responder.respond(input);
}
