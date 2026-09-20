import { describe, it, expect } from "vitest";
import { AnswerFileSchema, type AnswerFile } from "../../contracts/src/answerFile.js";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

const validFraud: AnswerFile = {
  case_id: "TEST-001",
  case: {
    status: "closed_fraud",
    verdict: "fraud",
    fraud_probability: 0.86,
    pattern: "card_testing",
    pattern_description: "",
    affected_txn_ids: ["9900001", "9900002"],
    first_suspicious_txn_id: "9900001",
    connected_card_ids: [],
    connected_device_profiles: [],
    exposure_usd: 264.72,
    evidence: [
      { claim: "test claim", source: "graph", ref: "query:test", entity_ids: ["9900001"] },
    ],
    similar_prior_cases: [],
    summary: "test summary",
    written_to_graph: true,
    graph_case_id: "CASE-TEST-001",
  },
  evidence_requests: [],
  next_best_actions: {
    initial: [{ action: "BLOCK_CARD", route: "L1", reason: "R5" }],
    final: [{ action: "BLOCK_CARD", route: "L1", reason: "R5" }],
    what_changed: "nothing",
  },
  sar: {
    file: false,
    reason: "below reporting threshold",
    narrative: "",
    subjects: [],
    total_amount_usd: 0,
    activity_dates: [],
  },
  investigation_record: [
    {
      seq: 0,
      ts: "2016-11-12T00:47:00Z",
      case_id: "TEST-001",
      type: "state_entered",
      state: "TRIGGERED",
      payload: {},
    },
    {
      seq: 1,
      ts: "2016-11-12T00:47:05Z",
      case_id: "TEST-001",
      type: "tool_call",
      state: "INVESTIGATING",
      payload: { tool: "get_transaction_history" },
    },
  ],
  stop_reason: "sufficient evidence",
  tool_calls: 5,
  tokens: 100,
  latency_s: 1.2,
};

const validLegitimate: AnswerFile = {
  ...clone(validFraud),
  case: {
    ...clone(validFraud.case),
    status: "closed_legitimate",
    verdict: "legitimate",
    fraud_probability: 0.05,
    pattern: "none",
    affected_txn_ids: [],
    exposure_usd: 0,
  },
  next_best_actions: {
    initial: [{ action: "CLOSE_NO_FRAUD", route: "auto", reason: "R3" }],
    final: [{ action: "CLOSE_NO_FRAUD", route: "auto", reason: "R3" }],
    what_changed: "nothing",
  },
};

describe("AnswerFileSchema — valid baselines", () => {
  it("accepts a valid closed_fraud answer file", () => {
    expect(AnswerFileSchema.safeParse(validFraud).success).toBe(true);
  });

  it("accepts a valid closed_legitimate answer file", () => {
    expect(AnswerFileSchema.safeParse(validLegitimate).success).toBe(true);
  });
});

describe("AnswerFileSchema — pattern_description rule", () => {
  it("rejects a non-empty pattern_description when pattern is not undocumented", () => {
    const bad = clone(validFraud);
    bad.case.pattern_description = "some description";
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty pattern_description when pattern is undocumented", () => {
    const bad = clone(validFraud);
    bad.case.pattern = "undocumented";
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a non-empty pattern_description when pattern is undocumented", () => {
    const ok = clone(validFraud);
    ok.case.pattern = "undocumented";
    ok.case.pattern_description = "A coordinated multi-account abuse pattern not matching the five known types.";
    expect(AnswerFileSchema.safeParse(ok).success).toBe(true);
  });
});

describe("AnswerFileSchema — legitimate verdict rules", () => {
  it("rejects non-empty affected_txn_ids when verdict is legitimate", () => {
    const bad = clone(validLegitimate);
    bad.case.affected_txn_ids = ["9900001"];
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-zero exposure_usd when verdict is legitimate", () => {
    const bad = clone(validLegitimate);
    bad.case.exposure_usd = 50;
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects sar.file true when verdict is legitimate", () => {
    const bad = clone(validLegitimate);
    bad.sar.file = true;
    bad.sar.narrative = "irrelevant narrative";
    bad.next_best_actions.final = [{ action: "FILE_REPORT", route: "L2", reason: "x" }];
    bad.next_best_actions.initial = bad.next_best_actions.final;
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("AnswerFileSchema — sar.file false rules", () => {
  it("rejects a non-empty narrative when sar.file is false", () => {
    const bad = clone(validFraud);
    bad.sar.narrative = "should not be here";
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-empty subjects when sar.file is false", () => {
    const bad = clone(validFraud);
    bad.sar.subjects = ["C09001"];
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("AnswerFileSchema — sar.file true rules", () => {
  it("rejects an empty narrative when sar.file is true", () => {
    const bad = clone(validFraud);
    bad.sar.file = true;
    bad.sar.subjects = ["C09001"];
    bad.sar.total_amount_usd = 264.72;
    bad.sar.activity_dates = ["2016-11-11", "2016-11-12"];
    bad.next_best_actions.initial = [{ action: "FILE_REPORT", route: "L2", reason: "R2" }];
    bad.next_best_actions.final = bad.next_best_actions.initial;
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects sar.file true when FILE_REPORT is absent from next_best_actions.final", () => {
    const bad = clone(validFraud);
    bad.sar.file = true;
    bad.sar.narrative = "A complete narrative describing who, what, when, where, how, and why.";
    bad.sar.subjects = ["C09001"];
    bad.sar.total_amount_usd = 264.72;
    bad.sar.activity_dates = ["2016-11-11", "2016-11-12"];
    // next_best_actions left as BLOCK_CARD only — no FILE_REPORT.
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts sar.file true when FILE_REPORT is present and narrative is filled in", () => {
    const ok = clone(validFraud);
    ok.sar.file = true;
    ok.sar.reason = "R2: shared device links this to another compromised card";
    ok.sar.narrative = "A complete narrative describing who, what, when, where, how, and why.";
    ok.sar.subjects = ["C09001", "C09001-K1"];
    ok.sar.total_amount_usd = 264.72;
    ok.sar.activity_dates = ["2016-11-11", "2016-11-12"];
    ok.next_best_actions.initial = [{ action: "FILE_REPORT", route: "L2", reason: "R2" }];
    ok.next_best_actions.final = ok.next_best_actions.initial;
    expect(AnswerFileSchema.safeParse(ok).success).toBe(true);
  });
});

describe("AnswerFileSchema — final-equals-initial rule", () => {
  it("rejects final differing from initial when evidence_requests is empty", () => {
    const bad = clone(validFraud);
    bad.next_best_actions.final = [{ action: "BLOCK_CARD", route: "L1", reason: "a different reason" }];
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects what_changed !== "nothing" when evidence_requests is empty', () => {
    const bad = clone(validFraud);
    bad.next_best_actions.what_changed = "something changed";
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts final differing from initial when evidence_requests is non-empty", () => {
    const ok = clone(validFraud);
    ok.evidence_requests = [
      { type: "customer_validation", asked_after_step: 4, assumed_response: "Customer denied the purchases" },
    ];
    ok.next_best_actions.final = [{ action: "BLOCK_CARD", route: "L1", reason: "R2: customer denied" }];
    ok.next_best_actions.what_changed = "Customer denial raised the probability and confirmed the block.";
    expect(AnswerFileSchema.safeParse(ok).success).toBe(true);
  });
});

describe("AnswerFileSchema — investigation_record", () => {
  it("rejects a missing investigation_record", () => {
    const bad = clone(validFraud);
    delete (bad as Record<string, unknown>).investigation_record;
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts an empty investigation_record at the schema level", () => {
    const ok = clone(validFraud);
    ok.investigation_record = [];
    expect(AnswerFileSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an event with a bad state/type enum", () => {
    const bad = clone(validFraud);
    (bad.investigation_record[1] as { state: string }).state = "NOT_A_STATE";
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("AnswerFileSchema — enum rejection", () => {
  it("rejects an unknown case.pattern value", () => {
    // why: intentionally violates the Pattern union to exercise the enum check.
    const bad = clone(validFraud) as unknown as Record<string, any>;
    bad.case.pattern = "not_a_real_pattern";
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown action name", () => {
    // why: intentionally violates the PolicyActionName union to exercise the enum check.
    const bad = clone(validFraud) as unknown as Record<string, any>;
    bad.next_best_actions.initial = [{ action: "NOT_A_REAL_ACTION", route: "L1", reason: "x" }];
    bad.next_best_actions.final = bad.next_best_actions.initial;
    expect(AnswerFileSchema.safeParse(bad).success).toBe(false);
  });
});
