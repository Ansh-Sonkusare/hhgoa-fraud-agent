import { describe, it, expect } from "vitest";
import { executeAction } from "../../policy/src/engine.js";
import { InMemoryActionsMock } from "../../policy/src/actionsMock.js";
import { UIApprovalChannel } from "../../policy/src/approvals/uiApprovalChannel.js";
import type { CaseStateForPolicy, ExecuteActionParams } from "../../policy/src/types.js";

function baseCaseState(overrides: Partial<CaseStateForPolicy> = {}): CaseStateForPolicy {
  return {
    case_id: "HHG-TEST-2",
    fraud_probability: 0.9,
    evidence_category_count: 3,
    exposure_usd: 100,
    customer_denied: false,
    customer_confirmed: false,
    confirmed_fraud_card_count: 0,
    credentials_confirmed_compromised: false,
    shared_origin_connection: false,
    coordinated_or_undocumented: false,
    fraud_confirmed_or_strongly_suspected: true,
    ...overrides,
  };
}

// PRD §10.5 hard guarantees.
describe("execute_action hard guarantees (PRD §10.5)", () => {
  it("1. is the only path to a side effect and always calls policy_check first: missing prerequisites -> DENIED with the reason surfaced", async () => {
    const actionsMock = new InMemoryActionsMock();
    const approvalChannel = new UIApprovalChannel();
    const params: ExecuteActionParams = {
      case_state: baseCaseState({ fraud_probability: 0.4, customer_denied: false }),
      reason: "test",
    };
    const outcome = await executeAction("BLOCK_CARD", params, { approvalChannel, actionsMock });
    expect(outcome.result).toBe("DENIED");
    expect(outcome.reason).toMatch(/R1/);
    // no side effect was recorded
    expect(actionsMock.getLog()).toHaveLength(0);
  });

  it("2. executable_by_agent: false actions can only ever reach PENDING_APPROVAL without a human decision", async () => {
    const actionsMock = new InMemoryActionsMock();
    const approvalChannel = new UIApprovalChannel();
    const params: ExecuteActionParams = {
      case_state: baseCaseState({ fraud_probability: 0.9, exposure_usd: 500 }),
      reason: "R5: card testing",
    };
    const outcome = await executeAction("BLOCK_CARD", params, { approvalChannel, actionsMock });
    expect(outcome.result).toBe("PENDING_APPROVAL");
    expect(actionsMock.getLog()).toHaveLength(0);
  });

  it("UI approve -> EXECUTED: once the channel records an approval, execute_action re-check returns EXECUTED and logs the effect", async () => {
    const actionsMock = new InMemoryActionsMock();
    const approvalChannel = new UIApprovalChannel();
    const cs = baseCaseState({ fraud_probability: 0.9, exposure_usd: 500 });
    const params: ExecuteActionParams = { case_state: cs, reason: "R5: card testing" };

    const pending = await executeAction("BLOCK_CARD", params, { approvalChannel, actionsMock });
    expect(pending.result).toBe("PENDING_APPROVAL");

    approvalChannel.resolve(cs.case_id, "BLOCK_CARD", "approved");
    const executed = await executeAction("BLOCK_CARD", params, { approvalChannel, actionsMock });
    expect(executed.result).toBe("EXECUTED");
    expect(actionsMock.getLog()).toHaveLength(1);
    expect(actionsMock.getLog()[0]?.action).toBe("BLOCK_CARD");
  });

  it("UI reject -> DENIED", async () => {
    const actionsMock = new InMemoryActionsMock();
    const approvalChannel = new UIApprovalChannel();
    const cs = baseCaseState({ fraud_probability: 0.9 });
    const params: ExecuteActionParams = { case_state: cs, reason: "test" };
    approvalChannel.resolve(cs.case_id, "FILE_REPORT", "rejected");
    const outcome = await executeAction(
      "FILE_REPORT",
      { case_state: { ...cs, exposure_usd: 2000 }, reason: "R2" },
      { approvalChannel, actionsMock },
    );
    expect(outcome.result).toBe("DENIED");
    expect(actionsMock.getLog()).toHaveLength(0);
  });

  it("auto actions execute immediately without any approval round-trip", async () => {
    const actionsMock = new InMemoryActionsMock();
    const approvalChannel = new UIApprovalChannel();
    const params: ExecuteActionParams = { case_state: baseCaseState(), reason: "R6" };
    const outcome = await executeAction("CREATE_CASE", params, { approvalChannel, actionsMock });
    expect(outcome.result).toBe("EXECUTED");
    expect(actionsMock.getLog()).toHaveLength(1);
  });
});
