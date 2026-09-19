import { describe, it, expect } from "vitest";
import {
  policyCheck,
  computeApprovalRoute,
  checkPrerequisites,
  sarRequired,
} from "../../policy/src/engine.js";
import type { CaseStateForPolicy } from "../../policy/src/types.js";

function baseCaseState(overrides: Partial<CaseStateForPolicy> = {}): CaseStateForPolicy {
  return {
    case_id: "HHG-TEST-1",
    fraud_probability: 0.5,
    evidence_category_count: 2,
    exposure_usd: 100,
    customer_denied: false,
    customer_confirmed: false,
    confirmed_fraud_card_count: 0,
    credentials_confirmed_compromised: false,
    shared_origin_connection: false,
    coordinated_or_undocumented: false,
    fraud_confirmed_or_strongly_suspected: false,
    ...overrides,
  };
}

describe("policy engine: policyCheck", () => {
  it("allows an auto action with no prerequisites (e.g. CREATE_CASE)", () => {
    const result = policyCheck("CREATE_CASE", baseCaseState());
    expect(result.allowed).toBe(true);
    expect(result.approval_route).toBe("auto");
    expect(result.missing_prerequisites).toEqual([]);
  });

  it("denies unknown action_or_request", () => {
    const result = policyCheck("NOT_A_REAL_ACTION", baseCaseState());
    expect(result.allowed).toBe(false);
    expect(result.missing_prerequisites[0]).toMatch(/unknown/);
  });

  it("R1: denies BLOCK_CARD below probability 0.70 without a customer denial", () => {
    const result = policyCheck("BLOCK_CARD", baseCaseState({ fraud_probability: 0.5 }));
    expect(result.allowed).toBe(false);
    expect(result.missing_prerequisites[0]).toMatch(/R1/);
  });

  it("R1: allows BLOCK_CARD when probability >= 0.70", () => {
    const result = policyCheck("BLOCK_CARD", baseCaseState({ fraud_probability: 0.82 }));
    expect(result.allowed).toBe(true);
  });

  it("R1: allows BLOCK_CARD below 0.70 once the customer has denied it", () => {
    const result = policyCheck(
      "BLOCK_CARD",
      baseCaseState({ fraud_probability: 0.5, customer_denied: true }),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK_CARD routes L1 at/under $2,500 exposure, L2 above", () => {
    const low = baseCaseState({ fraud_probability: 0.9, exposure_usd: 2500 });
    const high = baseCaseState({ fraud_probability: 0.9, exposure_usd: 2500.01 });
    expect(computeApprovalRoute("BLOCK_CARD", low)).toBe("L1");
    expect(computeApprovalRoute("BLOCK_CARD", high)).toBe("L2");
    expect(policyCheck("BLOCK_CARD", low).approval_route).toBe("L1");
    expect(policyCheck("BLOCK_CARD", high).approval_route).toBe("L2");
  });

  it("R10: denies BLOCK_ALL_CARDS with fewer than 2 confirmed-fraud cards and no compromised credentials", () => {
    const result = policyCheck(
      "BLOCK_ALL_CARDS",
      baseCaseState({ fraud_probability: 0.9, confirmed_fraud_card_count: 1 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.missing_prerequisites[0]).toMatch(/R10/);
  });

  it("R10: allows BLOCK_ALL_CARDS with 2 confirmed-fraud cards", () => {
    const result = policyCheck("BLOCK_ALL_CARDS", baseCaseState({ confirmed_fraud_card_count: 2 }));
    expect(result.allowed).toBe(true);
  });

  it("R10: allows BLOCK_ALL_CARDS via the compromised-credentials alternate gate", () => {
    const result = policyCheck(
      "BLOCK_ALL_CARDS",
      baseCaseState({ confirmed_fraud_card_count: 0, credentials_confirmed_compromised: true }),
    );
    expect(result.allowed).toBe(true);
  });

  it("§3a: denies FILE_REPORT when SAR conditions are not met", () => {
    const result = policyCheck(
      "FILE_REPORT",
      baseCaseState({ fraud_confirmed_or_strongly_suspected: true, exposure_usd: 50 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.missing_prerequisites[0]).toMatch(/§3a/);
  });

  it("§3a: allows FILE_REPORT when exposure exceeds $1,000 and fraud is confirmed", () => {
    const result = policyCheck(
      "FILE_REPORT",
      baseCaseState({ fraud_confirmed_or_strongly_suspected: true, exposure_usd: 1500 }),
    );
    expect(result.allowed).toBe(true);
  });

  it("evidence requests are always allowed with route auto", () => {
    for (const type of ["customer_validation", "step_up_auth", "analyst_info"]) {
      const result = policyCheck(type, baseCaseState());
      expect(result.allowed).toBe(true);
      expect(result.approval_route).toBe("auto");
    }
  });
});

describe("sarRequired (README §3a)", () => {
  it("is false when fraud is not confirmed/strongly suspected regardless of exposure", () => {
    expect(
      sarRequired({
        fraud_confirmed_or_strongly_suspected: false,
        exposure_usd: 5000,
        shared_origin_connection: true,
        coordinated_or_undocumented: true,
      }),
    ).toBe(false);
  });

  it("is true on exposure > $1,000 alone once fraud is confirmed", () => {
    expect(
      sarRequired({
        fraud_confirmed_or_strongly_suspected: true,
        exposure_usd: 1000.01,
        shared_origin_connection: false,
        coordinated_or_undocumented: false,
      }),
    ).toBe(true);
  });

  it("is false at exactly $1,000 with no other connecting factor", () => {
    expect(
      sarRequired({
        fraud_confirmed_or_strongly_suspected: true,
        exposure_usd: 1000,
        shared_origin_connection: false,
        coordinated_or_undocumented: false,
      }),
    ).toBe(false);
  });

  it("is true on a shared-origin connection alone, even under $1,000", () => {
    expect(
      sarRequired({
        fraud_confirmed_or_strongly_suspected: true,
        exposure_usd: 10,
        shared_origin_connection: true,
        coordinated_or_undocumented: false,
      }),
    ).toBe(true);
  });
});

describe("checkPrerequisites", () => {
  it("returns [] for actions with no configured prerequisites", () => {
    expect(checkPrerequisites("ALLOW_TRANSACTION", baseCaseState())).toEqual([]);
  });
});
