import { describe, it, expect } from "vitest";
import { AssessmentSchema } from "../../contracts/src/assessment.js";

describe("AssessmentSchema", () => {
  const valid = {
    hypotheses: [
      {
        fraud_type: "card_testing",
        probability: 0.7,
        supporting: ["ev_001"],
        contradicting: [],
      },
      {
        fraud_type: "legitimate",
        probability: 0.3,
        supporting: [],
        contradicting: ["ev_001"],
      },
    ],
    risk_level: "HIGH",
    risk_score: 0.82,
    confidence: 0.65,
    sufficiency: {
      sufficient: false,
      missing: [
        {
          what: "customer confirmation",
          why: "single-signal decision below the confidence guard",
          would_change_decision: true,
        },
      ],
      stop_reason: null,
    },
    legit_hypothesis_probability: 0.3,
  };

  it("accepts a valid assessment", () => {
    expect(AssessmentSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown risk_level", () => {
    const bad = { ...valid, risk_level: "APOCALYPTIC" };
    expect(AssessmentSchema.safeParse(bad).success).toBe(false);
  });
});
