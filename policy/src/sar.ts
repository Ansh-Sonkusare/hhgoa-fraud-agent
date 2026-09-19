import type { Sar } from "@hhgoa/contracts";
import { sarRequired, type SarInputState } from "./engine.js";

/**
 * Everything `buildSar` needs to render a narrative (README Answer Format
 * §Part 2, and README Fraud Policy §3a/§7: who, what, when, where, how, why
 * — the report must stand on its own to a regulator).
 */
export interface SarInputFacts extends SarInputState {
  case_id: string;
  customer_id: string;
  primary_card_id: string;
  connected_card_ids: string[];
  affected_txns: Array<{ txn_id: string; ts: string; amount_usd: number; product_cd?: string }>;
  device_profiles: string[];
  pattern: string;
  pattern_description: string;
  /** e.g. "R2: confirmed unauthorized use linked by a shared device to a second compromised card" */
  reason: string;
  channel_summary: string;
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtTime(iso: string): string {
  // "HH:MM" from an ISO timestamp, for readable narrative sentences.
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match?.[1] ?? iso;
}

function buildNarrative(facts: SarInputFacts): string {
  const txns = [...facts.affected_txns].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = txns[0];
  const last = txns[txns.length - 1];
  const totalAmount = txns.reduce((sum, t) => sum + Math.abs(t.amount_usd), 0);

  const sentences: string[] = [];

  // WHO / WHAT / WHEN
  if (first && last) {
    const amounts = txns.map((t) => fmtUsd(Math.abs(t.amount_usd))).join(", ");
    sentences.push(
      `On ${dateOnly(first.ts)} between ${fmtTime(first.ts)} and ${fmtTime(last.ts)}, card ${facts.primary_card_id} belonging to customer ${facts.customer_id} was used for ${txns.length} transaction(s) totaling ${fmtUsd(totalAmount)} (${amounts}).`,
    );
  } else {
    sentences.push(
      `Card ${facts.primary_card_id} belonging to customer ${facts.customer_id} shows activity totaling ${fmtUsd(totalAmount)} across ${txns.length} transaction(s).`,
    );
  }

  // WHERE / HOW (channel + pattern)
  sentences.push(`Activity occurred ${facts.channel_summary}.`);
  const patternSentence =
    facts.pattern === "undocumented" && facts.pattern_description
      ? facts.pattern_description
      : `The activity is consistent with the "${facts.pattern}" pattern.`;
  sentences.push(patternSentence);

  // Device / shared-origin (WHERE/HOW/WHY corroboration)
  if (facts.device_profiles.length > 0) {
    sentences.push(
      `The transactions share device profile(s): ${facts.device_profiles.join("; ")}.`,
    );
  }
  if (facts.connected_card_ids.length > 0) {
    sentences.push(
      `This activity connects to other card(s) held by the customer or by other customers: ${facts.connected_card_ids.join(", ")}.`,
    );
  }

  // WHY suspicious
  sentences.push(`This is reported because: ${facts.reason}.`);

  // Amount / disposition
  sentences.push(`Total suspicious amount: ${fmtUsd(totalAmount)}.`);
  sentences.push(
    `Card ${facts.primary_card_id} has been recommended for block and reissue; connected cards have been placed under monitoring where applicable.`,
  );

  return sentences.join(" ");
}

/**
 * Pure SAR builder (README Answer Format §Part 2 / Fraud Policy §3a, §7).
 * `file` is derived from the same `sarRequired` test the policy engine uses
 * for `FILE_REPORT`'s prerequisite, so the answer file's `sar.file` and
 * `next_best_actions.final` including `FILE_REPORT` can never disagree as
 * long as both are computed from the same case-state snapshot.
 */
export function buildSar(facts: SarInputFacts): Sar {
  const file = sarRequired(facts);
  if (!file) {
    return {
      file: false,
      reason: `Not filed: ${facts.reason || "SAR conditions (README §3a) not met."}`,
      narrative: "",
      subjects: [],
      total_amount_usd: 0,
      activity_dates: [],
    };
  }

  const txns = [...facts.affected_txns].sort((a, b) => a.ts.localeCompare(b.ts));
  const totalAmount = txns.reduce((sum, t) => sum + Math.abs(t.amount_usd), 0);
  const first = txns[0];
  const last = txns[txns.length - 1];
  const subjects = [
    facts.customer_id,
    facts.primary_card_id,
    ...facts.connected_card_ids,
  ].filter((s, i, arr) => arr.indexOf(s) === i);

  return {
    file: true,
    reason: facts.reason,
    narrative: buildNarrative(facts),
    subjects,
    total_amount_usd: Math.round(totalAmount * 100) / 100,
    activity_dates: first && last ? [dateOnly(first.ts), dateOnly(last.ts)] : [],
  };
}
