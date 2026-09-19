import { describe, expect, it } from "vitest";
import { writeCaseToMemory, getEntityCaseStats } from "../../rag/src/memory.js";
import type { CaseRecord } from "../../contracts/src/answerFile.js";
import type { VectorStore } from "../../rag/src/store/vectorStore.js";
import type { CaseMemoryRecord } from "../../rag/src/types.js";
import { LocalJsonVectorStore } from "../../rag/src/store/vectorStore.js";
import { fakeEmbedFn, makeCaseMemoryRecord } from "./helpers.js";

function makeCaseRecord(overrides: Partial<CaseRecord> & { summary: string }): CaseRecord {
  return {
    status: "closed_fraud",
    verdict: "fraud",
    fraud_probability: 0.93,
    pattern: "card_not_present_new_device",
    pattern_description: "",
    affected_txn_ids: ["3000555"],
    first_suspicious_txn_id: "3000555",
    connected_card_ids: ["C001-K2"],
    connected_device_profiles: ["DeviceInfo | Android | Chrome | 1920x1080"],
    exposure_usd: 740,
    evidence: [
      { claim: "denied the transaction", source: "customer", ref: "ev-1", entity_ids: ["C001"] },
    ],
    similar_prior_cases: ["CC-0100"],
    graph_case_id: "GRAPH-99",
    written_to_graph: true,
    ...overrides,
  };
}

describe("writeCaseToMemory", () => {
  it("stores a fingerprinted, embedded, as_of-visible record", async () => {
    const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
    const record = await writeCaseToMemory(store, fakeEmbedFn, {
      case_id: "HHG-020",
      case_record: makeCaseRecord({ summary: "online purchase from a brand new device, denied" }),
      customer_id: "C001",
      card_id: "C001-K1",
      as_of: "2016-09-01 10:00:00",
    });

    expect(record).toMatchObject({
      case_id: "HHG-020",
      source: "agent_written",
      customer_id: "C001",
      pattern: "card_not_present_new_device",
      outcome: "confirmed_fraud",
      visible_from: "2016-09-01 10:00:00",
      closed_at: "2016-09-01 10:00:00",
    });
    expect(record.embedding.length).toBeGreaterThan(0);
    expect(record.fingerprint.entity_ids).toContainEqual({ type: "Customer", id: "C001" });
    expect(store.get("HHG-020")).toBeDefined();
  });

  it("maps verdict+status to outcome for all four combinations", async () => {
    const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
    const combos: [CaseRecord["verdict"], CaseRecord["status"], CaseMemoryRecord["outcome"], string | null][] = [
      ["fraud", "closed_fraud", "confirmed_fraud", "2016-09-01 10:00:00"],
      ["legitimate", "closed_legitimate", "cleared", "2016-09-01 10:00:00"],
      // uncertain that escalated is not citable as precedent yet.
      ["uncertain", "escalated", "unresolved", null],
      ["uncertain", "open", "unresolved", null],
    ];
    for (const [verdict, status, outcome, closed_at] of combos) {
      const rec = await writeCaseToMemory(store, fakeEmbedFn, {
        case_id: `T-${verdict}-${status}`,
        case_record: makeCaseRecord({
          verdict,
          status,
          summary: `case with verdict ${verdict}, status ${status}`,
          exposure_usd: verdict === "legitimate" ? 0 : 100,
          affected_txn_ids: verdict === "legitimate" ? [] : ["3000555"],
        }),
        customer_id: "C1",
        card_id: "C1-K1",
        as_of: "2016-09-01 10:00:00",
      });
      expect(rec.outcome).toBe(outcome);
      expect(rec.closed_at).toBe(closed_at);
    }
  });
});

describe("getEntityCaseStats", () => {
  it("counts prior cases for a customer, respecting as_of", () => {
    const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
    for (const c of [
      makeCaseMemoryRecord({ case_id: "CC-0100", customer_id: "C001", visible_from: "2016-07-02 00:00:00", summary_text: "a" }),
      makeCaseMemoryRecord({ case_id: "CC-0200", customer_id: "C001", visible_from: "2016-08-15 00:00:00", summary_text: "b", outcome: "cleared" }),
      // Future: must not count as of the earlier date.
      makeCaseMemoryRecord({ case_id: "CC-FUT", customer_id: "C001", visible_from: "2016-12-01 00:00:00", summary_text: "c" }),
      // Different customer: must not count.
      makeCaseMemoryRecord({ case_id: "CC-0300", customer_id: "C099", visible_from: "2016-07-02 00:00:00", summary_text: "d" }),
    ]) {
      store.upsert(c.case_id, c.embedding, c);
    }

    const stats = getEntityCaseStats(store, { type: "Customer", id: "C001" }, "2016-09-01 00:00:00");
    expect(stats.prior_case_count).toBe(2);
    expect(stats.confirmed_fraud_count).toBe(1);
    expect(stats.cleared_count).toBe(1);
    expect(stats.case_ids.sort()).toEqual(["CC-0100", "CC-0200"]);

    // as_of leak check: before CC-0200 was visible, it must not count.
    const early = getEntityCaseStats(store, { type: "Customer", id: "C001" }, "2016-08-01 00:00:00");
    expect(early.case_ids).toEqual(["CC-0100"]);
  });

  it("matches by card id including connected cards", () => {
    const store = new LocalJsonVectorStore<CaseMemoryRecord>("/tmp/opencode/ws3-nowhere.json");
    const rec = makeCaseMemoryRecord({
      case_id: "CC-0100",
      customer_id: "C001",
      visible_from: "2016-07-02 00:00:00",
      summary_text: "a",
      connected_card_ids: ["C001-KX"],
    });
    store.upsert(rec.case_id, rec.embedding, rec);

    const byConnected = getEntityCaseStats(store, { type: "Card", id: "C001-KX" }, "2016-09-01 00:00:00");
    expect(byConnected.prior_case_count).toBe(1);
    const byMain = getEntityCaseStats(store, { type: "Card", id: rec.card_id }, "2016-09-01 00:00:00");
    expect(byMain.prior_case_count).toBe(1);
  });
});