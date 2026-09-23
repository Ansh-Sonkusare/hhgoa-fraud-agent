import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceItem, Hypothesis } from "../../contracts/src/index.js";
import { applyAlertCalibration, scoreAlertEvidence } from "../../agent/src/alertCalibration.js";
import { runAgent, createLlmClient } from "../../agent/src/agentFactory.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function item(id: string, summary: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id,
    category: "txn_behavior",
    summary,
    entities: [],
    source_tool: "test",
    weight_hint: 0.1,
    supports: [],
    contradicts: [],
    ts: "2016-08-01T00:00:00Z",
    ...extra,
  };
}

const ONLINE = item("ev_1", "Pattern shape: the flagged transaction was card-not-present (online), so the physical card was never presented");
const NEW_DEVICE = item("ev_2", "Pattern shape: the flagged transaction ran on a device profile this account has not been seen on before");
const NO_PRIOR = item("ev_3", "No prior fraud or cleared cases found for this customer or card", { category: "prior_cases" });

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

describe("scoreAlertEvidence (model-alert calibration)", () => {
  it("scores the fitted model exactly", () => {
    expect(scoreAlertEvidence([]).probability).toBeCloseTo(sigmoid(1.639), 6);
    // The typical cleared alert: online, new device, no prior cases.
    const typicalCleared = scoreAlertEvidence([ONLINE, NEW_DEVICE, NO_PRIOR]);
    expect(typicalCleared.probability).toBeCloseTo(sigmoid(1.639 + 1.181 - 3.346 - 1.179), 6);
    expect(typicalCleared.probability).toBeLessThan(0.2);
    expect(typicalCleared.terms.map((t) => t.feature)).toEqual([
      "flagged_charge_online",
      "flagged_charge_new_device",
      "no_prior_cases",
    ]);
    expect(typicalCleared.terms.map((t) => t.evidence_id)).toEqual(["ev_1", "ev_2", "ev_3"]);
    // Online on a known device with history: high.
    expect(scoreAlertEvidence([ONLINE]).probability).toBeGreaterThan(0.9);
  });

  it("counts a device-identity fraud signal only when it clears the independent-signal bar", () => {
    const ring = item("ev_9", "Card shares 3 device profiles with other cards", {
      category: "device_identity",
      weight_hint: 0.6,
      supports: ["fraud"],
    });
    const weak = { ...ring, weight_hint: 0.15 };
    const base = scoreAlertEvidence([ONLINE, NEW_DEVICE]).probability;
    expect(scoreAlertEvidence([ONLINE, NEW_DEVICE, ring]).probability).toBeGreaterThan(base);
    expect(scoreAlertEvidence([ONLINE, NEW_DEVICE, weak]).probability).toBeCloseTo(base, 10);
  });

  it("reads evidence wording that evidenceBuilder.ts still produces", () => {
    // The model was fitted on these exact phrases; if the evidence text changes,
    // the features silently stop firing. Join string concatenations first.
    const src = readFileSync(path.join(here, "../../agent/src/evidenceBuilder.ts"), "utf8").replace(/["`]\s*\+\s*["`]/g, "");
    for (const phrase of [
      "the flagged transaction was card-not-present (online)",
      "the flagged transaction ran on a device profile this account has not been seen on before",
      "No prior fraud or cleared cases found",
      "too few for an amount baseline",
      "ran on a device profile already associated with this account, while",
      "Similar closed case ${c.case_id} (score ${c.score.toFixed(2)}, ${c.outcome}): ${c.overlap_reason}",
    ]) {
      expect(src, phrase).toContain(phrase);
    }
  });
});

describe("applyAlertCalibration", () => {
  const hyps: Hypothesis[] = [
    { fraud_type: "card_not_present_fraud", probability: 0.6, supporting: [], contradicting: [] },
    { fraud_type: "account_takeover", probability: 0.3, supporting: [], contradicting: [] },
    { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: [] },
  ];

  it("sets the fraud mass to the calibrated probability and keeps the pattern ranking", () => {
    const cal = applyAlertCalibration(hyps, [ONLINE, NEW_DEVICE, NO_PRIOR])!;
    const p = scoreAlertEvidence([ONLINE, NEW_DEVICE, NO_PRIOR]).probability;
    expect(cal.from).toBeCloseTo(0.9, 10);
    expect(cal.to).toBeCloseTo(p, 3);
    const byType = Object.fromEntries(cal.hypotheses.map((h) => [h.fraud_type, h.probability]));
    expect(byType["card_not_present_fraud"]! / byType["account_takeover"]!).toBeCloseTo(2, 3);
    expect(byType["legitimate"]).toBeCloseTo(1 - cal.to, 6);
  });

  it("leaves an all-legitimate reading alone", () => {
    expect(
      applyAlertCalibration([{ fraud_type: "legitimate", probability: 1, supporting: [], contradicting: [] }], [ONLINE]),
    ).toBeNull();
  });
});

describe("machine: calibration applies to model alerts only", () => {
  const script = [
    {
      json: {
        hypotheses: [
          { fraud_type: "card_testing", probability: 0.95, supporting: [], contradicting: [] },
          { fraud_type: "legitimate", probability: 0.05, supporting: [], contradicting: [] },
        ],
        risk_level: "HIGH",
        risk_score: 0.95,
        confidence: 0.8,
        legit_hypothesis_probability: 0.05,
      },
    },
  ];
  const calibrationEvents = (events: { type: string; payload: Record<string, unknown> }[]) =>
    events.filter((e) => e.type === "assessment_updated" && e.payload["alert_calibration"] !== undefined);

  it("records the calibration on a risk_score trigger", async () => {
    const r = await runAgent({
      caseId: "HHG-CAL-1",
      asOf: "2016-11-12T00:35:00Z",
      trigger: { kind: "risk_score", risk_score: 0.78 },
      llm: createLlmClient("mock", script),
      backend: "fake",
    });
    const ev = calibrationEvents(r.events);
    expect(ev.length).toBeGreaterThanOrEqual(1);
    const cal = ev[0]!.payload["alert_calibration"] as { fraud_probability_from: number; fraud_probability_to: number };
    expect(cal.fraud_probability_from).toBeCloseTo(0.95, 6);
    expect(cal.fraud_probability_to).toBeGreaterThan(0);
    expect(cal.fraud_probability_to).toBeLessThan(1);
  });

  it("leaves a customer dispute to the assessor", async () => {
    const r = await runAgent({
      caseId: "HHG-CAL-2",
      asOf: "2016-11-12T00:35:00Z",
      trigger: { kind: "customer_report", customer_id: "C09001", text: "I did not make these purchases" },
      llm: createLlmClient("mock", script),
      backend: "fake",
    });
    expect(calibrationEvents(r.events)).toEqual([]);
  });
});
