import type { Trigger } from "@hhgoa/contracts";
import type { BenchmarkCase } from "./dataset.js";

/**
 * Maps one case-pack row to the `Trigger` the WS4 machine consumes
 * (PRD §8.4). Mirrors api/src/liveRunSource.ts `buildTriggerFromCasePack`
 * field-for-field — eval/ re-implements it locally rather than importing
 * from the WS6-owned api package. `as_of` for a run is `case.opened_at`.
 */
export function buildTrigger(c: BenchmarkCase): Trigger {
  switch (c.trigger_type) {
    case "risk_score":
      return { kind: "risk_score", txn_id: c.flagged_txn_id, card_id: c.card_id, risk_score: c.risk_score ?? 0.5 };
    case "customer_report":
      return {
        kind: "customer_report",
        customer_id: c.customer_id,
        txn_ids: c.flagged_txn_id ? [c.flagged_txn_id] : undefined,
        text: c.trigger_text,
      };
    case "analyst_request":
      return { kind: "analyst_request", entity: { type: "Card", id: c.card_id }, question: c.trigger_text };
  }
}