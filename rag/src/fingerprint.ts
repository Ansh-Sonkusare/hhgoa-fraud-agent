import { amountBand, type CaseFingerprint } from "./types.js";
import type { TransactionSignal } from "./sources/transactionSignals.js";

export interface FingerprintInput {
  pattern: string;
  customer_id: string;
  card_id: string;
  connected_card_ids: string[];
  exposure_usd: number;
  outcome: "confirmed_fraud" | "cleared" | "unresolved";
  /** Signal for the representative (first-suspicious/flagged) transaction, if joined. */
  signal?: TransactionSignal;
}

/**
 * PRD §11: "fingerprint = {pattern, key entity ids/types, amounts band,
 * device/address signals, outcome}". `device_signals`/`address_signals`
 * come from a bounded streaming join against transactions.csv/identity.csv
 * (`sources/transactionSignals.ts`) — optional because it's only computed
 * for the representative transaction, and online-only for device (README:
 * `ProductCD=W` / in-person has no identity record).
 */
export function buildFingerprint(input: FingerprintInput): CaseFingerprint {
  const entity_ids: CaseFingerprint["entity_ids"] = [
    { type: "Customer", id: input.customer_id },
    { type: "Card", id: input.card_id },
    ...input.connected_card_ids.map((id) => ({ type: "Card", id })),
  ];

  const device_signals: string[] = [];
  const address_signals: string[] = [];
  if (input.signal) {
    if (input.signal.device_profile) device_signals.push(input.signal.device_profile);
    if (input.signal.addr1 && input.signal.addr1.trim().length > 0) {
      address_signals.push(input.signal.addr1.trim());
    }
  }

  return {
    pattern: input.pattern,
    entity_ids,
    amount_band: amountBand(input.exposure_usd),
    device_signals,
    address_signals,
    outcome: input.outcome,
  };
}

/**
 * Entity-overlap score between two fingerprints — the non-cosine half of
 * `retrieve_similar_cases`'s score (PRD §11: "cosine(summary) +
 * entity-overlap (shared card/device/address/identity/community)").
 * Community/identity-vertex overlap isn't available yet (WS1/WS2
 * territory); this scores what's available now: shared customer, shared
 * card (incl. connected cards), same pattern, same amount band, shared
 * device profile, shared billing region. Returns a value roughly in
 * [0, 1] — not a probability, a ranking signal.
 */
export function entityOverlapScore(a: CaseFingerprint, b: CaseFingerprint): number {
  let score = 0;
  const aCardIds = new Set(a.entity_ids.filter((e) => e.type === "Card").map((e) => e.id));
  const bCardIds = new Set(b.entity_ids.filter((e) => e.type === "Card").map((e) => e.id));
  const aCustomerIds = new Set(
    a.entity_ids.filter((e) => e.type === "Customer").map((e) => e.id),
  );
  const bCustomerIds = new Set(
    b.entity_ids.filter((e) => e.type === "Customer").map((e) => e.id),
  );

  const sharedCards = [...aCardIds].filter((id) => bCardIds.has(id));
  const sharedCustomers = [...aCustomerIds].filter((id) => bCustomerIds.has(id));
  const sharedDevices = a.device_signals.filter((d) => b.device_signals.includes(d));
  const sharedAddresses = a.address_signals.filter((d) => b.address_signals.includes(d));

  if (sharedCustomers.length > 0) score += 0.3;
  if (sharedCards.length > 0) score += 0.3;
  if (sharedDevices.length > 0) score += 0.25;
  if (sharedAddresses.length > 0) score += 0.1;
  if (a.pattern !== "none" && a.pattern === b.pattern) score += 0.15;
  if (a.amount_band === b.amount_band) score += 0.05;

  return Math.min(1, score);
}

/** Human-readable reason a case was retrieved as "similar" — required by
 * the WS3 DoD ("similar-case test returns overlap explanation"). */
export function explainOverlap(a: CaseFingerprint, b: CaseFingerprint): string {
  const reasons: string[] = [];
  const aCardIds = new Set(a.entity_ids.filter((e) => e.type === "Card").map((e) => e.id));
  const bCardIds = a === b ? aCardIds : new Set(b.entity_ids.filter((e) => e.type === "Card").map((e) => e.id));
  const aCustomerIds = new Set(
    a.entity_ids.filter((e) => e.type === "Customer").map((e) => e.id),
  );
  const bCustomerIds = new Set(
    b.entity_ids.filter((e) => e.type === "Customer").map((e) => e.id),
  );
  const sharedCards = [...aCardIds].filter((id) => bCardIds.has(id));
  const sharedCustomers = [...aCustomerIds].filter((id) => bCustomerIds.has(id));
  const sharedDevices = a.device_signals.filter((d) => b.device_signals.includes(d));
  const sharedAddresses = a.address_signals.filter((d) => b.address_signals.includes(d));

  if (sharedCustomers.length > 0) reasons.push(`same customer (${sharedCustomers.join(", ")})`);
  if (sharedCards.length > 0) reasons.push(`shared card(s) (${sharedCards.join(", ")})`);
  if (sharedDevices.length > 0) reasons.push(`shared device profile`);
  if (sharedAddresses.length > 0) {
    // addr1 is loaded as a number, so region 231 arrives as "231.0"; display only.
    const label = (r: string): string => r.replace(/^(\d+)\.0+$/, "$1");
    reasons.push(`shared billing region (${sharedAddresses.map(label).join(", ")})`);
  }
  if (a.pattern !== "none" && a.pattern === b.pattern) {
    reasons.push(`same pattern (${a.pattern})`);
  }
  if (a.amount_band === b.amount_band) reasons.push(`similar exposure band (${a.amount_band})`);

  if (reasons.length === 0) {
    return "retrieved by narrative similarity only (no shared entities/pattern/amount band found)";
  }
  return reasons.join("; ");
}
