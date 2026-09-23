/**
 * Which transactions after the flagged charge belong to its fraud episode
 * (README: affected_txn_ids is "every transaction you believe is part of the
 * same fraud episode, including the flagged one"; exposure is their summed
 * amount).
 *
 * A per-transaction logistic score over facts the agent already holds for
 * every row in its sweep. It replaced a single filter ("same channel as the
 * flagged charge and risk_score >= 0.3") that took ordinary spending into
 * card-present episodes: an out-of-region episode is the flagged charge's own
 * foreign billing region, often at near-identical amounts, and an account
 * takeover's rows come from regions the card had not used earlier in the window.
 *
 * How it was fitted (docs/decisions.md, 2026-09-23):
 * - 2,710 held-out confirmed-fraud closed cases (every account takeover,
 *   out-of-region, card-testing and undocumented case, plus 300 of each
 *   card-not-present pattern), none of the 100 backtest cases. Each case's
 *   transactions as the agent sees them at `opened_at`; every analyst episode
 *   transaction was visible in all of them.
 * - Split by case id into a design half and a check half. Features, the
 *   regularisation and the 0.4 cutoff were chosen on design-half
 *   cross-validation; the check half was scored once, with the model fitted on
 *   the design half only.
 * - Check half (1,344 cases), current filter -> this model: exposure within 25%
 *   of the analysts' on 65% -> 74% of cases, exposure on the wrong side of the
 *   $1,000 report line (R2, 3a) 7.0% -> 5.2%. Account takeover 64% -> 73%,
 *   out-of-region 60% -> 75%, plain card-not-present 78% -> 83%;
 *   card-not-present on a new device slips 74% -> 71%. Card testing (9 cases in
 *   the whole history outside the backtest) shows nothing to fit on and is left
 *   to the general score.
 * - No transaction before the flagged charge was ever in an analyst's episode
 *   (0 of 964 in the design half), but the README says the flagged charge "is
 *   not necessarily where the fraud started", so the two hours before it stay
 *   candidates, as before.
 *
 * The risk score scopes an episode the case is already about; it never decides
 * the verdict.
 */
import type { TransactionHistoryRow } from "../../contracts/src/index.js";

/** Fields txn_history.gsql returns beyond the frozen contract row (see evidenceBuilder.ts). */
export type EpisodeRow = TransactionHistoryRow & {
  addr1?: string;
  id_15?: string;
  m_flags?: string;
};

/** Candidates start this long before the flagged charge. */
export const EPISODE_LOOKBACK_HOURS = 2;
/** A row joins the episode at this score or above (design-half cross-validation). */
export const EPISODE_MIN_SCORE = 0.4;
/** README card-testing probes: tiny online charges always join an online episode. */
export const TINY_ONLINE_USD = 5;

const INTERCEPT = -5.7583;
const WEIGHTS = {
  risk: 6.3156,
  same_channel: 0.0974,
  same_addr: 1.8966,
  addr_empty: 1.5063,
  log_hours_after: 0.088,
  same_product: 0.0322,
  id15_new: -1.3601,
  flagged_online: 0.1083,
  tiny_online: 0.8018,
  log_amount: -0.0205,
  new_addr: 0.7713,
  amount_near_flagged: 1.4924,
  failed_checks: 0.155,
  same_mflags: 1.6294,
  no_prior_addr: 0.4196,
} as const;

const HOUR_MS = 3_600_000;

function tsMs(ts: string): number {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  return Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
}

function failedChecks(m: string | undefined): number {
  let n = 0;
  for (const ch of m ?? "") if (ch === "F") n += 1;
  return n;
}

/** Billing regions the card used before the candidate window, in the same sweep. */
export function priorRegions(rows: readonly EpisodeRow[], flagged: EpisodeRow): Set<string> {
  const from = tsMs(flagged.ts) - EPISODE_LOOKBACK_HOURS * HOUR_MS;
  return new Set(rows.filter((r) => tsMs(r.ts) < from && r.addr1).map((r) => r.addr1!));
}

/** Probability that `r` belongs to the flagged charge's episode. */
export function episodeScore(r: EpisodeRow, flagged: EpisodeRow, prior: ReadonlySet<string>): number {
  const addr = r.addr1 ?? "";
  const hours = Math.max(0, (tsMs(r.ts) - tsMs(flagged.ts)) / HOUR_MS);
  const flaggedAmount = flagged.amount_usd || 1;
  const m = r.m_flags ?? "";
  const f = {
    risk: r.risk_score,
    same_channel: r.channel === flagged.channel ? 1 : 0,
    same_addr: addr !== "" && addr === (flagged.addr1 ?? "") ? 1 : 0,
    addr_empty: addr === "" ? 1 : 0,
    log_hours_after: Math.log1p(hours),
    same_product: r.product_cd === flagged.product_cd ? 1 : 0,
    id15_new: r.id_15 === "New" ? 1 : 0,
    flagged_online: flagged.channel === "online" ? 1 : 0,
    tiny_online: r.channel === "online" && r.amount_usd < TINY_ONLINE_USD ? 1 : 0,
    log_amount: Math.log1p(r.amount_usd),
    new_addr: addr !== "" && prior.size > 0 && !prior.has(addr) ? 1 : 0,
    amount_near_flagged: Math.abs(r.amount_usd - flaggedAmount) / flaggedAmount < 0.05 ? 1 : 0,
    failed_checks: failedChecks(m),
    same_mflags: m !== "" && m === (flagged.m_flags ?? "") ? 1 : 0,
    no_prior_addr: prior.size === 0 ? 1 : 0,
  };
  let z = INTERCEPT;
  for (const k of Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>) z += WEIGHTS[k] * f[k];
  return 1 / (1 + Math.exp(-z));
}
