import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../../contracts/src/evidenceItem.js";
import type { Hypothesis } from "../../contracts/src/assessment.js";
import {
  applyPatternScore,
  patternScorerFromEnv,
  SCORER_PATTERNS,
  renderScorerState,
  SERVED_STATE_LIMITS,
  SystemOneScorer,
  type PatternScore,
  type PatternScorer,
} from "../../agent/src/patternScorer.js";
import { runAgent, createLlmClient } from "../../agent/src/agentFactory.js";
import { fraudProbability } from "../../agent/src/assess.js";

function item(partial: Partial<EvidenceItem> & Pick<EvidenceItem, "id" | "summary" | "source_tool">): EvidenceItem {
  return {
    category: "txn_behavior",
    entities: [],
    weight_hint: 0.3,
    supports: [],
    contradicts: [],
    ts: "2016-09-02 00:00:00",
    ...partial,
  };
}

function score(top: (typeof SCORER_PATTERNS)[number], p: number): PatternScore {
  const rest = (1 - p) / (SCORER_PATTERNS.length - 1);
  const probabilities = Object.fromEntries(SCORER_PATTERNS.map((k) => [k, k === top ? p : rest])) as PatternScore["probabilities"];
  return { choice: top, confidence: 0.5, probabilities };
}

describe("renderScorerState", () => {
  it("leaves out the dispute text, the R7 line and the static external lookup", () => {
    const state = renderScorerState([
      item({ id: "e1", source_tool: "customer_report", category: "customer_response", summary: "Cardholder C00001 disputed transaction 1" }),
      item({ id: "e2", source_tool: "get_transaction_history", summary: "R7 checked and does not apply: 0 earlier charge(s)" }),
      item({ id: "e3", source_tool: "lookup_external", category: "external", summary: 'External email_domain "gmail.com"' }),
      item({ id: "e4", source_tool: "compute_velocity", summary: "3 transaction(s) totaling $50.00 in the last 1440 minutes" }),
    ]);
    expect(state).not.toMatch(/disputed|R7|email_domain/);
    expect(state).toContain("3 transaction(s) totaling $50.00");
  });

  it("replaces identifier lists with counts and aggregates rings and similar cases", () => {
    const state = renderScorerState([
      item({ id: "d1", source_tool: "detect_patterns", category: "policy_match", summary: 'Pattern "card_testing" detected with score 0.90 on txn(s) 3190345, 3190311, 3189454' }),
      item({ id: "p1", source_tool: "find_prior_cases", category: "prior_cases", summary: "Prior confirmed fraud case(s) CC-0429, CC-1401 (pattern card_not_present_new_device/card_not_present_new_device)" }),
      item({ id: "s1", source_tool: "retrieve_similar_cases", category: "prior_cases", summary: "Similar closed case CC-1235 (score 0.30, confirmed_fraud): same customer (C08962); shared card(s) (C08962-K2)" }),
      item({ id: "s2", source_tool: "retrieve_similar_cases", category: "prior_cases", summary: "Similar closed case CC-0010 (score 0.17, cleared): shared card(s) (C03246-K1)" }),
      item({ id: "r1", source_tool: "find_shared_entity_rings", category: "device_identity", summary: "Activity shares device profile b05147e3d61f3749 with card(s) C07562-K2" }),
      item({ id: "r2", source_tool: "find_shared_entity_rings", category: "device_identity", summary: "Shares device profile f3b4cbf030eceb47 with 10 other cards — too large a group to be a specific fraud ring" }),
    ]);
    expect(state).toContain('Pattern "card_testing" detected with score 0.90 on 3 txn(s)');
    expect(state).toContain("Prior confirmed fraud 2 case(s) (patterns: card_not_present_new_device x2)");
    expect(state).toContain("Similar closed cases: 2 (confirmed_fraud 1, cleared 1); best score 0.30");
    expect(state).toContain("Shared-entity rings: 1 specific shared device profile(s); 1 shared profile(s) too common to be a ring");
    expect(state).not.toMatch(/CC-\d|C\d{5}|[0-9a-f]{16}/);
    // Detector lines lead the state.
    expect(state.split("\n")[0]).toContain("card_testing");
  });

  it("stays inside Kev's training window", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ id: `x${i}`, source_tool: "get_transaction_history", summary: `Distinct observation number ${i} ${"about the card ".repeat(8)}` }),
    );
    expect(renderScorerState(many).length).toBeLessThanOrEqual(1400);
  });
});

describe("applyPatternScore", () => {
  const hyps: Hypothesis[] = [
    { fraud_type: "card_not_present_fraud", probability: 0.6, supporting: ["e1"], contradicting: [] },
    { fraud_type: "account_takeover", probability: 0.15, supporting: [], contradicting: [] },
    { fraud_type: "legitimate", probability: 0.25, supporting: ["e9"], contradicting: [] },
  ];
  const evidence = [item({ id: "d1", source_tool: "detect_patterns", summary: "card testing", supports: ["card_testing"] })];

  it("moves the top pattern to Kev's choice and keeps the fraud-vs-legitimate mass", () => {
    const out = applyPatternScore(hyps, score("card_testing", 0.8), evidence);
    const top = [...out].filter((h) => h.fraud_type !== "legitimate").sort((a, b) => b.probability - a.probability)[0]!;
    expect(top.fraud_type).toBe("card_testing");
    expect(top.probability).toBeCloseTo(0.75 * 0.8, 5);
    expect(out.find((h) => h.fraud_type === "legitimate")).toEqual(hyps[2]);
    expect(fraudProbability({ hypotheses: out, legit_hypothesis_probability: 0.25 })).toBeCloseTo(0.75, 6);
    expect(out.reduce((s, h) => s + h.probability, 0)).toBeCloseTo(1, 6);
    // A pattern the assessor never proposed cites the evidence that names it.
    expect(top.supporting).toEqual(["d1"]);
    // One the assessor did propose keeps its own citations.
    expect(out.find((h) => h.fraud_type === "card_not_present_fraud")!.supporting).toEqual(["e1"]);
  });

  it("leaves an all-legitimate assessment and an undocumented hypothesis alone", () => {
    const legit: Hypothesis[] = [{ fraud_type: "legitimate", probability: 1, supporting: [], contradicting: [] }];
    expect(applyPatternScore(legit, score("card_testing", 0.9), evidence)).toEqual(legit);
    const undoc: Hypothesis[] = [
      { fraud_type: "undocumented", probability: 0.5, supporting: [], contradicting: [] },
      { fraud_type: "out_of_region_use", probability: 0.3, supporting: [], contradicting: [] },
      { fraud_type: "legitimate", probability: 0.2, supporting: [], contradicting: [] },
    ];
    const out = applyPatternScore(undoc, score("account_takeover", 0.7), evidence);
    expect(out.find((h) => h.fraud_type === "undocumented")!.probability).toBe(0.5);
    expect(out.filter((h) => SCORER_PATTERNS.includes(h.fraud_type as never)).reduce((s, h) => s + h.probability, 0)).toBeCloseTo(0.3, 6);
  });
});

describe("machine with a pattern scorer", () => {
  const run = (scorer: PatternScorer | null) =>
    runAgent({
      caseId: "HHG-KEV-1",
      asOf: "2016-11-12T00:35:00Z",
      trigger: { kind: "risk_score", risk_score: 0.78 },
      llm: createLlmClient("mock"),
      backend: "fake",
      scorer,
    });

  it("files Kev's pattern, logs the call, and keeps the verdict", async () => {
    const states: string[] = [];
    const kev: PatternScorer = {
      name: "jev",
      scorePattern: (state) => {
        states.push(state);
        return Promise.resolve(score("card_not_present_fraud", 0.9));
      },
    };
    const [withKev, without] = [await run(kev), await run(null)];
    expect(states.length).toBeGreaterThan(0);
    expect(withKev.answer.case.pattern).toBe("card_not_present_fraud");
    expect(without.answer.case.pattern).toBe("card_testing");
    expect(withKev.answer.case.verdict).toBe(without.answer.case.verdict);
    expect(withKev.answer.case.fraud_probability).toBeCloseTo(without.answer.case.fraud_probability, 6);
    expect(withKev.events.some((e) => e.type === "tool_result" && e.payload["tool"] === "jev_pattern_score")).toBe(true);
  });

  it("does not file a card-present pattern on an online flagged charge, whatever the scorer says", async () => {
    // The fixture's flagged charge is online (channel rule, patternRules.ts).
    const jev: PatternScorer = { name: "jev", scorePattern: () => Promise.resolve(score("account_takeover", 0.9)) };
    const r = await run(jev);
    expect(r.answer.case.pattern).not.toBe("account_takeover");
    const logged = r.events.find((e) => e.type === "assessment_updated" && e.payload["channel_rule"] !== undefined);
    expect((logged?.payload["channel_rule"] as { from: string } | undefined)?.from).toBe("account_takeover");
  });

  it("falls back to the assessor's ranking when Kev fails", async () => {
    const kev: PatternScorer = { name: "kev", scorePattern: () => Promise.reject(new Error("connection refused")) };
    const r = await run(kev);
    expect(r.answer.case.pattern).toBe("card_testing");
    const result = r.events.find((e) => e.type === "tool_result" && e.payload["tool"] === "kev_pattern_score");
    expect(result?.payload["result"]).toMatchObject({ ok: false });
  });
});

describe("SystemOneScorer (Jev / Kev System One client)", () => {
  const answer = (choice: string) => ({
    answers: {
      pattern: {
        type: "choice",
        choice,
        confidence: 0.6,
        probabilities: Object.fromEntries(SCORER_PATTERNS.map((p) => [p, p === choice ? 0.8 : 0.05])),
      },
    },
  });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("posts the state and the pattern question to /v1/systemone with the bearer key and model", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const scorer = new SystemOneScorer({
      name: "jev",
      baseUrl: "https://api.typesafe.ai/",
      model: "jev-latest",
      apiKey: "k-123",
      fetchImpl: (url, init) => {
        seen.push({ url: String(url), init: init! });
        return Promise.resolve(ok(answer("out_of_region_use")));
      },
    });
    const s = await scorer.scorePattern("- some evidence");
    expect(s.choice).toBe("out_of_region_use");
    expect(seen[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((seen[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k-123");
    const body = JSON.parse(String(seen[0]!.init.body)) as { model: string; state: string; questions: { pattern: { type: string; criteria: Record<string, string> } } };
    expect(body.model).toBe("jev-latest");
    expect(body.state).toBe("- some evidence");
    expect(Object.keys(body.questions.pattern.criteria)).toEqual([...SCORER_PATTERNS]);
  });

  it("retries 429 and 529 with backoff, but not a 401", async () => {
    const statuses = [429, 529];
    const waits: number[] = [];
    const scorer = new SystemOneScorer({
      name: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKey: "k",
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      fetchImpl: () => {
        const st = statuses.shift();
        return Promise.resolve(st ? new Response("busy", { status: st }) : ok(answer("card_testing")));
      },
    });
    expect((await scorer.scorePattern("x")).choice).toBe("card_testing");
    expect(waits).toEqual([1000, 2000]);

    const denied = new SystemOneScorer({
      name: "jev",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKey: "bad",
      sleep: () => Promise.reject(new Error("must not retry")),
      fetchImpl: () => Promise.resolve(new Response("unauthorized", { status: 401 })),
    });
    await expect(denied.scorePattern("x")).rejects.toThrow(/jev: HTTP 401/);
  });

  it("rejects an answer missing a pattern's probability", async () => {
    const scorer = new SystemOneScorer({
      name: "kev",
      baseUrl: "http://127.0.0.1:8009",
      model: "kev-latest",
      fetchImpl: () => Promise.resolve(ok({ answers: { pattern: { choice: "card_testing", probabilities: { card_testing: 1 } } } })),
    });
    await expect(scorer.scorePattern("x")).rejects.toThrow(/no probability for card_not_present_fraud/);
  });

  it("picks the scorer from the environment", () => {
    expect(patternScorerFromEnv({})).toBeNull();
    expect(patternScorerFromEnv({ JEV_API_KEY: "k" })?.name).toBe("jev");
    expect(patternScorerFromEnv({ KEV_URL: "http://127.0.0.1:8009" })?.name).toBe("kev");
    expect(patternScorerFromEnv({ JEV_API_KEY: "k", PATTERN_SCORER: "none" })).toBeNull();
    expect(patternScorerFromEnv({ JEV_API_KEY: "k", KEV_URL: "http://x", PATTERN_SCORER: "kev" })?.name).toBe("kev");
    expect(() => patternScorerFromEnv({ PATTERN_SCORER: "jev" })).toThrow(/JEV_API_KEY/);
  });
});

describe("scorer state limits (iteration 15)", () => {
  const home = item({
    id: "h1",
    source_tool: "get_transaction_history",
    summary:
      "The flagged transaction is in billing region 330, the card's usual region before this window " +
      "(145 of 281 card-present transactions in the 83 days before this window); a charge where the card " +
      "is normally used does not fit out-of-region use",
  });

  it("keeps region codes so region lines still read", () => {
    expect(renderScorerState([home], SERVED_STATE_LIMITS)).toContain("billing region 330, the card's usual region");
  });

  it("gives a served scorer every line whole, conclusion included", () => {
    expect(renderScorerState([home], SERVED_STATE_LIMITS)).toContain("does not fit out-of-region use");
    // Kev's training-sized default still caps the line.
    expect(renderScorerState([home])).not.toContain("out-of-region use");
  });

  it("uses the served limits for Jev and the training limits for Kev", () => {
    expect(patternScorerFromEnv({ JEV_API_KEY: "k" })?.stateLimits).toEqual(SERVED_STATE_LIMITS);
    expect(patternScorerFromEnv({ KEV_URL: "http://x", PATTERN_SCORER: "kev" })?.stateLimits?.charBudget).toBe(1400);
  });
});

describe("annotated served state (iteration 17)", () => {
  it("carries each item's weight and patterns for Jev, as the assessor's brief does", () => {
    const away = item({
      id: "a1",
      source_tool: "get_transaction_history",
      summary: "Card-present activity in this window is away from the card's usual region 264: 11 regions",
      weight_hint: 0.75,
      supports: ["out_of_region_use"],
    });
    const det = item({
      id: "d1",
      source_tool: "detect_patterns",
      summary: 'Pattern "account_takeover" detected with score 0.80 on txn(s) 1, 2, 3',
      weight_hint: 0.36,
      supports: ["account_takeover"],
    });
    const served = renderScorerState([away, det], SERVED_STATE_LIMITS);
    expect(served).toContain("(weight 0.75; supports out_of_region_use) Card-present activity");
    expect(served).toContain("(weight 0.36; supports account_takeover) Pattern");
    expect(renderScorerState([away, det])).not.toContain("weight 0.75");
  });
});
