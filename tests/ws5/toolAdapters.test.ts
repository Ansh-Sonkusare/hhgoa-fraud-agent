import { describe, it, expect } from "vitest";
import { createPolicyToolAdapters } from "../../policy/src/toolAdapters.js";
import { InMemoryActionsMock } from "../../policy/src/actionsMock.js";
import { UIApprovalChannel } from "../../policy/src/approvals/uiApprovalChannel.js";
import { SimulatedResponder } from "../../policy/src/evidence.js";
import { toolResultSchema } from "../../contracts/src/toolEnvelope.js";
import { PolicyCheckResultSchema } from "../../contracts/src/policy.js";
import { SarSchema } from "../../contracts/src/answerFile.js";
import type { CaseStateForPolicy } from "../../policy/src/types.js";
import type { SarInputFacts } from "../../policy/src/sar.js";

function makeAdapters() {
  return createPolicyToolAdapters({
    approvalChannel: new UIApprovalChannel(),
    actionsMock: new InMemoryActionsMock(),
    responder: new SimulatedResponder(),
  });
}

const cs: CaseStateForPolicy = {
  case_id: "HHG-TEST-5",
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
};

describe("policy tool adapters (ToolCatalog-shaped)", () => {
  it("policy_check returns a valid envelope", async () => {
    const adapters = makeAdapters();
    const result = await adapters.policy_check({
      action_or_request: "CREATE_CASE",
      case_state: cs,
    });
    const schema = toolResultSchema(PolicyCheckResultSchema);
    const parsed = schema.safeParse(result);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect(result.data.allowed).toBe(true);
  });

  it("execute_action executes an auto action end-to-end", async () => {
    const adapters = makeAdapters();
    const result = await adapters.execute_action({
      action: "CREATE_CASE",
      params: { case_state: cs, reason: "R6" },
    });
    expect(result.ok).toBe(true);
    expect(result.data.result).toBe("EXECUTED");
  });

  it("execute_action surfaces DENIED with a reason for missing prerequisites", async () => {
    const adapters = makeAdapters();
    const result = await adapters.execute_action({
      action: "BLOCK_CARD",
      params: { case_state: { ...cs, fraud_probability: 0.3 }, reason: "weak signal" },
    });
    expect(result.ok).toBe(false);
    expect(result.data.result).toBe("DENIED");
    expect(result.error).toMatch(/R1/);
  });

  it("request_evidence returns a valid envelope carrying an evidence_ref", async () => {
    const adapters = makeAdapters();
    const result = await adapters.request_evidence({
      type: "customer_validation",
      target: { type: "Card", id: "C0001-K1" },
      reason: "R1: verify before blocking",
    });
    expect(result.ok).toBe(true);
    expect(result.data.request_type).toBe("customer_validation");
    expect(result.evidence_refs).toEqual([result.data.evidence.id]);
  });

  it("generate_sar renders after registerCaseFacts, and fails clearly before it", async () => {
    const adapters = makeAdapters();
    await expect(adapters.generate_sar("HHG-UNKNOWN")).rejects.toThrow(/no case facts registered/);

    const facts: SarInputFacts = {
      case_id: "HHG-TEST-5",
      customer_id: "C09101",
      primary_card_id: "C09101-K1",
      connected_card_ids: [],
      affected_txns: [{ txn_id: "9910001", ts: "2016-11-14T09:12:10Z", amount_usd: 1500 }],
      device_profiles: [],
      pattern: "card_not_present_fraud",
      pattern_description: "",
      reason: "R2: exposure exceeds $1,000",
      channel_summary: "online",
      fraud_confirmed_or_strongly_suspected: true,
      exposure_usd: 1500,
      shared_origin_connection: false,
      coordinated_or_undocumented: false,
    };
    adapters.registerCaseFacts("HHG-TEST-5", facts);
    const result = await adapters.generate_sar("HHG-TEST-5");
    expect(result.ok).toBe(true);
    const parsed = SarSchema.safeParse(result.data);
    expect(parsed.success).toBe(true);
    expect(result.data.file).toBe(true);
  });
});
