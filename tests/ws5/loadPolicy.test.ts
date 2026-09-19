import { describe, it, expect } from "vitest";
import { PolicyActionNameSchema, EvidenceRequestTypeSchema } from "../../contracts/src/answerFile.js";
import { loadPolicyConfig } from "../../policy/src/loadPolicy.js";

describe("policy/policy.yaml", () => {
  const cfg = loadPolicyConfig();

  it("parses and validates against PolicyConfigSchema", () => {
    expect(cfg.actions).toBeTruthy();
    expect(cfg.evidence_requests).toBeTruthy();
    expect(cfg.sar.required_if.length).toBeGreaterThan(0);
  });

  it("encodes all 14 README Fraud Policy §1 actions", () => {
    const expected = PolicyActionNameSchema.options;
    expect(expected).toHaveLength(14);
    for (const action of expected) {
      expect(cfg.actions[action], `missing policy.yaml entry for ${action}`).toBeDefined();
    }
    expect(Object.keys(cfg.actions)).toHaveLength(14);
  });

  it("encodes all 3 evidence-request types", () => {
    const expected = EvidenceRequestTypeSchema.options;
    expect(expected).toHaveLength(3);
    for (const type of expected) {
      expect(cfg.evidence_requests[type], `missing policy.yaml entry for ${type}`).toBeDefined();
    }
    expect(Object.keys(cfg.evidence_requests)).toHaveLength(3);
  });

  it("routes match README Fraud Policy §2", () => {
    const autoActions = [
      "ALLOW_TRANSACTION",
      "MONITOR_CARD",
      "MONITOR_CONNECTED_CARDS",
      "WARN_CUSTOMER",
      "VERIFY_WITH_CUSTOMER",
      "STEP_UP_AUTH",
      "GENERATE_REPORT",
      "CREATE_CASE",
      "ESCALATE_TO_ANALYST",
      "CLOSE_NO_FRAUD",
    ] as const;
    for (const a of autoActions) {
      expect(cfg.actions[a]?.executable_by_agent).toBe(true);
      expect(cfg.actions[a]?.approval_route).toBe("none");
    }
    expect(cfg.actions["DECLINE_TRANSACTION"]?.approval_route).toBe("L1");
    expect(cfg.actions["DECLINE_TRANSACTION"]?.executable_by_agent).toBe(false);
    expect(cfg.actions["BLOCK_ALL_CARDS"]?.approval_route).toBe("L2");
    expect(cfg.actions["FILE_REPORT"]?.approval_route).toBe("L2");
    expect(cfg.actions["BLOCK_CARD"]?.executable_by_agent).toBe(false);
  });
});
