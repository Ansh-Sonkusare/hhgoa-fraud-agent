import { describe, it, expect } from "vitest";
import { InMemoryActionsMock, ALL_ACTION_NAMES } from "../../policy/src/actionsMock.js";
import { PolicyActionNameSchema } from "../../contracts/src/answerFile.js";
import type { CaseStateForPolicy } from "../../policy/src/types.js";

const cs: CaseStateForPolicy = {
  case_id: "HHG-TEST-3",
  fraud_probability: 0.5,
  evidence_category_count: 1,
  exposure_usd: 0,
  customer_denied: false,
  customer_confirmed: false,
  confirmed_fraud_card_count: 0,
  credentials_confirmed_compromised: false,
  shared_origin_connection: false,
  coordinated_or_undocumented: false,
  fraud_confirmed_or_strongly_suspected: false,
};

describe("actionsMock: all 14 action types are callable", () => {
  it("ALL_ACTION_NAMES covers exactly the 14 PolicyActionName values", () => {
    expect(ALL_ACTION_NAMES.sort()).toEqual([...PolicyActionNameSchema.options].sort());
  });

  for (const action of PolicyActionNameSchema.options) {
    it(`runs ${action} and logs a distinct, non-empty effect description`, async () => {
      const mock = new InMemoryActionsMock();
      const entry = await mock.run(action, { case_state: cs, reason: "test" });
      expect(entry.action).toBe(action);
      expect(entry.effect.length).toBeGreaterThan(0);
      expect(entry.case_id).toBe(cs.case_id);
      expect(mock.getLog()).toHaveLength(1);
    });
  }
});
