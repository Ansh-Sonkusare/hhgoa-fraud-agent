import type { SharedEntityRing } from "@hhgoa/contracts";
import type { InvestigationFacts } from "./investigation.js";

/**
 * Corroborated "shared origin" derivation (PRD §8.1/§9.5, policy R6, README
 * §3a). `shared_origin_connection` is defined as "the evidence connects to a
 * shared device/region/another card's fraud" — not merely "this card shares
 * some attribute with at least one other card". A raw shared element is weak:
 * `DeviceProfile` is a coarse fingerprint (DeviceInfo + OS + browser +
 * screen), and `addr1` is a billing *region* / email is a *domain*
 * (docs/decisions.md), so ordinary collisions are common. This module turns
 * the raw ring set into a decision only when something corroborates a common
 * actor, so the policy layer cannot be forced into a SAR by a fingerprint
 * crowd.
 *
 * Two independent corroborators, both grounded in existing evidence:
 *  - prior confirmed fraud on the customer/card (`find_prior_cases`, already
 *    part of the compact sweep) — §3a's literal "another customer's fraud";
 *  - a genuine, fraud-concentrated community from `get_community`, whose
 *    `community_lookup` query applies the same 2-distinct-types + overlap WCC
 *    as the discovery pass (docs/decisions.md) and reports the closed-case
 *    confirmation rate.
 */

/**
 * A shared entity touched by more than a handful of cards is a crowd, not an
 * identifying origin. The three genuine discovered components are 5/5/9 cards
 * while the observed noise bands are 29-47 (HHG-007) and 45 (HHG-001)
 * (docs/decisions.md). `mcpClient.ts` still drops >50 rings as sentinel-scale
 * noise at the transport layer; this is the stricter evidence bar.
 */
export const MAX_CORROBORATING_RING_SIZE = 10;

/**
 * Match the discovery pass's own qualifying bar (`min_confirmed_pct = 90`,
 * docs/decisions.md): the graph's genuine clusters sit at 100% and the
 * rejected 274-card volume artifact was 81.6% — below the 83.2% dataset
 * baseline. A community must therefore be *fraud-enriched relative to the
 * data*, not merely contain a fraud case, to corroborate a shared origin.
 */
export const COMMUNITY_FRAUD_RATE_MIN = 0.9;

export interface SharedOriginSignals {
  /** A shared-element ring of a plausibly specific size exists (2..N). */
  plausible_ring: boolean;
  /** Smallest plausible ring size, or null when there is none. */
  corroborating_ring_size: number | null;
  /** A prior case with outcome "confirmed_fraud" exists for the customer/card. */
  prior_confirmed_fraud: boolean;
  /** The community is multi-card and fraud-concentrated (>= COMMUNITY_FRAUD_RATE_MIN). */
  community_confirmed: boolean;
  community_size: number | null;
  community_fraud_rate: number | null;
}

export interface SharedOriginAssessment {
  shared_origin_connection: boolean;
  /** The rings the case may report — corroborated + plausible, else empty. */
  rings: SharedEntityRing[];
  connected_card_ids: string[];
  device_profiles: string[];
  signals: SharedOriginSignals;
  /** Human-readable basis for the decision (cited by the recommender). */
  reason: string;
}

function explain(s: SharedOriginSignals): string {
  if (!s.plausible_ring) {
    return "no shared device, address, or email ring of a plausible size";
  }
  if (s.prior_confirmed_fraud) {
    return "links this card to another card's confirmed fraud";
  }
  if (s.community_confirmed) {
    return `community of ${s.community_size} cards with ${Math.round(
      (s.community_fraud_rate ?? 0) * 100,
    )}% confirmed-fraud incidence`;
  }
  return "a shared element exists, but nothing corroborates it as a common actor";
}

export function assessSharedOrigin(facts: InvestigationFacts): SharedOriginAssessment {
  const plausible = facts.rings.filter(
    (r) => r.card_ids.length >= 2 && r.card_ids.length <= MAX_CORROBORATING_RING_SIZE,
  );
  const primary = facts.primary_card?.id ?? null;
  // R2/R6 and §3a speak of *another* card's or customer's fraud. The card's
  // own earlier fraud is a fact about this card, not a link to anyone else:
  // on 150 cleared + 150 fraud closed cases the cited fraud was the card's own
  // history in 43/43 and 107/110 hits, and the old reading reported every one
  // of them as a shared origin (CC-1660: 30 unrelated cards put under
  // monitoring). find_prior_cases marks own cases; recordings made before
  // that field existed keep the old reading.
  const priorConfirmedFraud = facts.prior_cases.some(
    (c) => c.outcome === "confirmed_fraud" && (c as { own?: boolean }).own !== true,
  );
  const rate = facts.community?.stats["confirmed_fraud_rate"] ?? null;
  // A community corroborates only if its cases resolve as fraud more often
  // than closed cases do generally at the same as_of (community_lookup.gsql
  // population_confirmed_fraud_rate); most closed cases are disputes, so the
  // raw rate clears a fixed bar almost everywhere. Absent the population
  // figure (older recordings), the fixed bar alone applies as before.
  const population = facts.community?.stats["population_confirmed_fraud_rate"];
  const communityConfirmed =
    facts.community !== null &&
    facts.community.size >= 2 &&
    rate !== null &&
    rate >= COMMUNITY_FRAUD_RATE_MIN &&
    (population === undefined || population <= 0 || rate > population);

  const plausibleRing = plausible.length > 0;
  const shared = plausibleRing && (priorConfirmedFraud || communityConfirmed);
  const rings = shared ? plausible : [];

  const signals: SharedOriginSignals = {
    plausible_ring: plausibleRing,
    corroborating_ring_size: plausibleRing
      ? Math.min(...plausible.map((r) => r.card_ids.length))
      : null,
    prior_confirmed_fraud: priorConfirmedFraud,
    community_confirmed: communityConfirmed,
    community_size: facts.community?.size ?? null,
    community_fraud_rate: rate,
  };

  return {
    shared_origin_connection: shared,
    rings,
    connected_card_ids: [
      ...new Set(rings.flatMap((r) => r.card_ids).filter((c) => c !== primary)),
    ],
    device_profiles: [
      ...new Set(rings.filter((r) => r.shared_type === "device").map((r) => r.shared_id)),
    ],
    signals,
    reason: explain(signals),
  };
}
