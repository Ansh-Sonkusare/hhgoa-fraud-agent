import type {
  EvidenceCategory,
  EvidenceEntityRef,
  EvidenceItem,
} from "@hhgoa/contracts";
import { MAX_CORROBORATING_RING_SIZE } from "./sharedOrigin.js";

/**
 * A billing-region code for display. addr1 is loaded as a number, so the graph
 * returns "239.0" for region 239; the evidence text read as if regions were
 * measurements. Comparisons keep the raw value -- this is display only.
 */
export function regionLabel(code: string | number | null | undefined): string {
  const s = String(code ?? "");
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s;
}

/** docs/DATASET_README.md: addr1 is the "Billing region"; shared_rings calls it "address". */
function sharedTypeLabel(t: string): string {
  return t === "address" ? "billing region" : `${t} profile`;
}

function ringIdLabel(ring: { shared_type: string; shared_id: string }): string {
  return ring.shared_type === "address" ? regionLabel(ring.shared_id) : ring.shared_id;
}

function sharedTypeEntityType(sharedType: string): string {
  switch (sharedType) {
    case "device":
      return "Device";
    case "address":
      return "Address";
    case "email":
      return "EmailDomain";
    default:
      return sharedType;
  }
}


/**
 * Marks a claim that decides *which* fraud pattern a case would be if it is
 * fraud -- the flagged charge's channel, whether its device was new to the
 * account -- as opposed to evidence *that* it is fraud. Rendered in its own
 * section of the brief (contextBuilder.ts). Listed among the ordinary evidence
 * with `supports: [<fraud patterns>]` at 0.5, the assessor read these as fraud
 * support: on the three cleared model alerts in the iteration-11 backtest they
 * were the two heaviest items voting for fraud, although the same facts hold
 * for a cardholder shopping online from a new phone. A text prefix rather than
 * a field because EvidenceItem is a frozen contract, and it survives the copies
 * the evidence store and event log make.
 */
export const PATTERN_SHAPE_PREFIX = "Pattern shape: ";

export function isPatternShape(e: Pick<EvidenceItem, "summary">): boolean {
  return e.summary.startsWith(PATTERN_SHAPE_PREFIX);
}

/**
 * Evidence builder (PRD §8.3): turns raw tool `data` into typed
 * `EvidenceItem[]`. Ids come from a run-local `EvidenceIdGen` so whole runs
 * are numerically deterministic (`ev_001`, `ev_002`, ...). Summaries are
 * deterministic prose over the tool's *actual* returned data — never
 * invented claims about rows the tool did not return (PRD §9.3: assess on
 * evidence you received, not on what you hoped to see).
 *
 * Category mapping (docs/DATA_MAP.md + contracts evidenceItem.ts):
 *  graph_structure  ← resolve_trigger, get_entity_profile, get_neighborhood, get_community
 *  txn_behavior     ← get_transaction_history, compute_velocity, get_baseline_deviation
 *  device_identity  ← find_shared_entity_rings
 *  prior_cases      ← find_prior_cases, retrieve_similar_cases
 *  policy_match     ← detect_patterns
 *  external         ← lookup_external
 *  customer_response← evidence responses (items already carry their category)
 */
export interface EvidenceIdGen {
  next(tool: string): string;
}

export function createEvidenceIdGen(): EvidenceIdGen {
  let counter = 0;
  return {
    next() {
      counter += 1;
      return `ev_${String(counter).padStart(3, "0")}`;
    },
  };
}

function ref(type: string, id: string): EvidenceEntityRef {
  return { type, id };
}

export function buildEvidenceForTool(
  tool: string,
  data: unknown,
  idGen: EvidenceIdGen,
  asOf: string,
  seedCardId?: string,
  flaggedTxnId?: string,
  flaggedChannel?: string,
): EvidenceItem[] {
  switch (tool) {
    case "resolve_trigger":
      // Resolution is bookkeeping, not evidence: the recorded fixtures start
      // their evidence at the first analytical tool (txn_behavior), so this
      // deliberately emits nothing.
      return [];
    case "get_transaction_history":
      return txnHistoryEvidence(data, idGen, asOf, flaggedTxnId);
    case "compute_velocity":
      return velocityEvidence(data, idGen, asOf);
    case "get_baseline_deviation":
      return baselineEvidence(data, idGen, asOf);
    case "find_shared_entity_rings":
      return ringsEvidence(data, idGen, asOf, seedCardId);
    case "detect_patterns":
      return patternsEvidence(data, idGen, asOf, flaggedChannel);
    case "get_community":
      return communityEvidence(data, idGen, asOf);
    case "get_neighborhood":
      return neighborhoodEvidence(data, idGen, asOf);
    case "find_prior_cases":
      return priorCasesEvidence(data, idGen, asOf);
    case "retrieve_similar_cases":
      return similarCasesEvidence(data, idGen, asOf);
    case "get_entity_profile":
      return profileEvidence(data, idGen, asOf);
    case "lookup_external":
      return lookupExternalEvidence(data, idGen, asOf);
    default:
      return [];
  }
}

/**
 * The transaction fields that separate the documented patterns. They are read
 * locally rather than added to TransactionHistoryRow because contracts/ is
 * frozen after M0; txn_history.gsql returns them and the client passes rows
 * through untouched, so they arrive at runtime either way. Every field is
 * optional: the fake backend does not produce them.
 */
interface DiscriminatingTxnFields {
  addr1?: string;
  id_15?: string;
  id_23?: string;
  /**
   * m1..m9 concatenated by txn_history.gsql. Position is not recoverable
   * (the flags are "T", "F" or blank), but only the count of failed checks
   * matters here, and one field beats nine in the tuple.
   */
  m_flags?: string;
}

/**
 * The card's usual card-present region(s) over a window that ends where the
 * investigation window begins. Ties are all kept: two equally used regions are
 * both "home", which only ever makes the away claim harder to trigger.
 */
export interface BaselineHome {
  regions: string[];
  /** Card-present transactions in the most-used region. */
  count: number;
  /** Card-present transactions with a region, over the whole baseline. */
  total: number;
  days: number;
}

export function computeBaselineHome(
  rows: ReadonlyArray<{ channel: string; addr1?: string | null }>,
  days: number,
): BaselineHome | undefined {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.channel !== "in_person" || !r.addr1) continue;
    counts.set(r.addr1, (counts.get(r.addr1) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const max = Math.max(...counts.values());
  const regions = [...counts.entries()].filter(([, n]) => n === max).map(([k]) => k).sort();
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { regions, count: max, total, days };
}

type TxnRow = {
  txn_id: string; ts: string; amount_usd: number;
  product_cd: string; channel: string; risk_score: number;
} & DiscriminatingTxnFields;

function mismatchCount(r: TxnRow): number {
  let n = 0;
  for (const ch of r.m_flags ?? "") if (ch === "F") n += 1;
  return n;
}

/**
 * One claim per discriminating signal actually present in the window. Without
 * these the brief can only ever describe generic card-not-present activity,
 * so out_of_region_use and account_takeover were never nameable at all no
 * matter what the underlying activity was.
 */
function discriminatingEvidence(
  rows: TxnRow[],
  idGen: EvidenceIdGen,
  asOf: string,
  flaggedTxnId?: string,
  baselineHome?: BaselineHome,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const add = (
    summary: string,
    supports: string[],
    weight: number,
    ents: TxnRow[],
    contradicts: string[] = [],
  ): void => {
    items.push({
      id: idGen.next("get_transaction_history"),
      category: "txn_behavior",
      summary,
      entities: ents.map((r) => ref("Transaction", r.txn_id)),
      source_tool: "get_transaction_history",
      ts: asOf,
      supports,
      contradicts,
      weight_hint: weight,
    });
  };

  const flagged = flaggedTxnId ? rows.find((r) => r.txn_id === flaggedTxnId) : undefined;

  // The presentment channel of the flagged transaction rules whole families of
  // pattern in or out, and does so definitionally rather than statistically:
  // "card not present" means the card was not physically presented. Measured
  // over every confirmed-fraud closed case with a flagged transaction, the
  // split is near-total -- card_not_present_fraud (n=1404),
  // card_not_present_new_device (n=1076) and card_testing (n=16) are online in
  // 100% of cases, while out_of_region_use (n=955) is card-present in 100% and
  // account_takeover (n=1205) in 93%. Stating it as evidence stops the agent
  // naming a card-not-present pattern on a charge the cardholder physically
  // made, which was a standing source of confusion between these two families.
  //
  // It names the family the pattern must belong to. It is not a vote for
  // fraud -- the channel of one purchase is as consistent with the cardholder
  // shopping normally as with fraud -- but it IS the classification signal
  // that decides which fraud pattern is even possible, and the assessor needs
  // it to pick the right one. Measured on the same leak-free 20-case sample:
  // with the family named (supports at 0.7) pattern exact was 47.1% with 0/17
  // false negatives; with `supports` emptied (contradicts-only, iteration 1)
  // it fell to 29.4% with 4/17 false negatives, and cleared-case escalation
  // was 3/3 either way -- so removing the family cost fraud classification
  // and bought nothing on cleared cases. Restored at 0.5: enough to steer the
  // family, below the 0.6-0.85 the actual pattern detectors carry.
  const CNP_PATTERNS = ["card_not_present_fraud", "card_not_present_new_device", "card_testing"];
  const CARD_PRESENT_PATTERNS = ["out_of_region_use", "account_takeover"];
  if (flagged?.channel === "in_person") {
    add(
      PATTERN_SHAPE_PREFIX +
        "the flagged transaction was card-present (in person), so the card itself was used - " +
        "if this is fraud it is a card-present pattern, not a card-not-present one",
      CARD_PRESENT_PATTERNS,
      0.5,
      [flagged],
      CNP_PATTERNS,
    );
  } else if (flagged?.channel === "online") {
    add(
      PATTERN_SHAPE_PREFIX +
        "the flagged transaction was card-not-present (online), so the physical card was never presented - " +
        "if this is fraud it is a card-not-present pattern",
      CNP_PATTERNS,
      0.5,
      [flagged],
      // Not out_of_region_use: that pattern is about where the card was
      // physically used, and it is card-present in every closed case measured.
      // Not account_takeover either: it is card-present in 93% of closed
      // cases, so of the ~2,590 confirmed-fraud cases whose flagged charge was
      // online only 84 (3.2%) were account takeovers. The card-level
      // account_takeover detector cannot see the flagged charge and fires at
      // 0.8 on card-not-present cases (iteration 6 named two of them
      // account_takeover); this is the item that knows the channel.
      ["out_of_region_use", "account_takeover"],
    );
  }

  // Whether the *flagged* transaction itself ran on a device new to the
  // account tells *which* card-not-present pattern a fraud would be: among
  // confirmed-fraud cases whose flagged charge was online, it is New on 74% of
  // card_not_present_new_device and 0% of card_not_present_fraud -- the pair
  // the agent most often confused.
  //
  // It is not, on its own, evidence that the charge was unauthorised. The old
  // encoding (supports new_device at 0.80, 0.85 with a proxy) cited "precision
  // 0.93", but that was measured with cleared cases excluded. Measured over all
  // 5,565 closed cases, the flagged online charge of a *cleared* alert is on a
  // New device 98% of the time (747/763) -- more often than genuine new-device
  // fraud -- and behind a proxy 7% vs 5%, so the proxy boost separated nothing.
  // At 0.80-0.85 it was a main driver of cleared model alerts reaching p~0.9
  // and being blocked. So it is framed like the channel claim: it names the
  // pattern *if* this is fraud, at the same 0.5, and the text says a new device
  // is also how a cardholder shops from a new phone or browser -- a statement
  // about reading the evidence, not about how these cases resolve.
  if (flagged && flagged.id_15 === "New") {
    const proxied = (flagged.id_23 ?? "") !== "";
    // Further new-device charges in the window used to be a separate item
    // supporting the same pattern at 0.35. It fired on essentially every
    // cleared online alert alongside this one -- a second vote for the same
    // fact -- so the count is stated here and cited, not voted twice.
    const alsoNew = rows.filter((r) => r.id_15 === "New" && r.txn_id !== flaggedTxnId);
    add(
      PATTERN_SHAPE_PREFIX +
        "the flagged transaction ran on a device profile this account has not been seen on before" +
        (proxied ? ", behind a proxy" : "") +
        (alsoNew.length > 0
          ? ` (${alsoNew.length} further transaction(s) in the window were also on a new device profile)`
          : "") +
        " - if this is fraud it is the new-device card-not-present pattern rather than stolen " +
        "credentials used on a known device; on its own a new device does not show the charge was " +
        "unauthorised, since a cardholder shopping from a new phone or browser looks the same",
      ["card_not_present_new_device"],
      0.5,
      [flagged, ...alsoNew],
      ["card_not_present_fraud"],
    );
  } else if (flagged && flagged.id_15 === "Found") {
    // Device data exists for the flagged transaction and says the account has
    // been seen on it before. That rules out the new-device pattern and
    // nothing else: a known device is exactly what account takeover looks
    // like (the attacker is inside the account) and what card-not-present
    // fraud with stolen credentials looks like too. The previous encoding
    // read it as `supports: ["legitimate"]` at 0.45, and on CC-5475 -- 114
    // items, account_takeover detected at 0.80, seven shared device profiles
    // -- that was the only legitimate-leaning item in the brief and the case
    // still closed `legitimate` at 0.35. A single ambiguous fact must not be
    // stated as a vote for the cardholder. Rules out; supports nothing.
    //
    // When other online charges in the window are on a new device the flagged
    // one is not, the rule-out is too strong but the lean survives. Measured
    // on 540 held-out closed cases (none of the 50 backtest cases): with the
    // flagged online charge on a known device and other online charges New,
    // 69 were card_not_present_fraud and 23 card_not_present_new_device. An
    // earlier version of this branch supported the new-device pattern here,
    // on the strength of the 23 alone -- the wrong direction.
    const otherNew = rows.filter((r) => r.id_15 === "New" && r.channel === "online" && r.txn_id !== flaggedTxnId);
    // ...except when a new-device charge sits right next to the flagged one.
    // Measured on 2,696 held-out closed cases (none of the 50 backtest cases),
    // flagged online charge on a known device with other New online charges:
    // a New charge within 30 minutes of the flagged one on 38/96
    // card_not_present_new_device vs 8/227 card_not_present_fraud; between 30
    // and 60 minutes 7 vs 10. Weighted by how often each pattern occurs in the
    // history, new-device is the majority within 30 minutes and stops being
    // it after, so that is where the episode reading changes.
    const flaggedMs = Date.parse(flagged.ts);
    const nearNew = otherNew.filter(
      (r) => Math.abs(Date.parse(r.ts) - flaggedMs) <= NEW_DEVICE_EPISODE_MINUTES * 60_000,
    );
    if (flagged.channel === "online" && nearNew.length > 0) {
      add(
        PATTERN_SHAPE_PREFIX +
          "the flagged transaction ran on a device profile already associated with this account, but " +
          `${nearNew.length} other online transaction(s) within ${NEW_DEVICE_EPISODE_MINUTES} minutes of it ran on a ` +
          "device profile this account has not been seen on before - if this is fraud the episode is the new-device " +
          "card-not-present pattern; on its own a new device does not show the charges were unauthorised",
        ["card_not_present_new_device"],
        0.4,
        [flagged, ...nearNew],
        ["card_not_present_fraud"],
      );
    } else if (flagged.channel === "online" && otherNew.length > 0) {
      add(
        PATTERN_SHAPE_PREFIX +
          "the flagged transaction ran on a device profile already associated with this account, while " +
          `${otherNew.length} other online transaction(s) in the window ran on a device profile this account ` +
          "has not been seen on before - the alerted charge itself is not on a new device, which leans away " +
          "from the new-device pattern without ruling it out",
        [],
        0.3,
        [flagged, ...otherNew],
        ["card_not_present_new_device"],
      );
    } else {
      add(
        PATTERN_SHAPE_PREFIX +
          "the flagged transaction ran on a device profile already associated with this account - " +
          "so not the new-device pattern; a known device is consistent with the cardholder and with " +
          "an attacker already inside the account alike",
        [],
        0.45,
        [flagged],
        ["card_not_present_new_device"],
      );
    }
  }

  const inPerson = rows.filter((r) => r.channel === "in_person" && (r.addr1 ?? "") !== "");
  const regions = new Map<string, TxnRow[]>();
  for (const r of inPerson) {
    const k = r.addr1 as string;
    regions.set(k, [...(regions.get(k) ?? []), r]);
  }
  const sortedRegions = [...regions.entries()].sort((a, b) => b[1].length - a[1].length);
  const homeRegion = sortedRegions[0];
  // Where the flagged card-present charge sits relative to the card's usual
  // region separates the two card-present patterns, and says little about
  // fraud versus legitimate. Measured over the closed history in the same
  // 7-day window the agent sees: the flagged charge is in the card's
  // most-used region for 71% of account_takeover cases but 18% of
  // out_of_region_use cases. This item used to support `legitimate`, yet it
  // fired on 40% of account_takeover cases against 3% of cleared ones, so it
  // pushed confirmed takeovers toward a clean verdict. It now only rules out
  // out_of_region_use and claims nothing about misuse. Stated only when the
  // window shows a second region, so one region of history is never read as
  // "home" on no evidence.
  const flaggedInPerson = flagged?.channel === "in_person" && (flagged.addr1 ?? "") !== "";
  // "Home" has to come from BEFORE the window, because the window is where the
  // episode happens. On a busy card the fraud burst dominates it: CC-1665
  // (gold out_of_region_use) put 31 of 59 card-present charges in the
  // fraudster's region, so the window's own mode read that region as home and
  // the case was called a takeover. On a quiet card the flagged charge is the
  // only card-present row there is. Measured over 2,071 closed card-present
  // account_takeover / out_of_region_use cases, the flagged charge is in the
  // card's most-used region over the 83 days before the window (90 days back
  // from as_of, excluding the 7-day window) for 85% of
  // account_takeover and 8% of out_of_region_use; the window's own mode gave
  // 88% vs 28%. Whether the region was merely SEEN before separates nothing
  // (97% vs 83%): addr1 is a coarse billing region, and out-of-region fraud
  // usually lands somewhere the card has been, just not where it lives.
  const pre = baselineHome && baselineHome.regions.length > 0 ? baselineHome : undefined;
  const preHome = new Set(pre?.regions ?? []);
  const flaggedAtPreHome = pre !== undefined && flaggedInPerson && preHome.has(flagged?.addr1 as string);
  const flaggedAwayFromPreHome = pre !== undefined && flaggedInPerson && !flaggedAtPreHome;
  if (pre) {
    const baseDesc =
      `${pre.count} of ${pre.total} card-present transactions in the ${pre.days} days before this window`;
    const awayRows = inPerson.filter((r) => !preHome.has(r.addr1 as string));
    const homeRecent = inPerson.length - awayRows.length;
    if (flaggedAtPreHome && flagged) {
      add(
        `The flagged transaction is in billing region ${regionLabel(flagged.addr1)}, the card's usual region before this ` +
          `window (${baseDesc}); a charge where the card is normally used does not fit out-of-region use`,
        [],
        0.6,
        [flagged],
        ["out_of_region_use"],
      );
    } else if (
      awayRows.length > 0 &&
      (flaggedAwayFromPreHome || (flagged === undefined && awayRows.length * 2 >= inPerson.length))
    ) {
      const awayRegions = new Map<string, TxnRow[]>();
      for (const r of awayRows) {
        const k = r.addr1 as string;
        awayRegions.set(k, [...(awayRegions.get(k) ?? []), r]);
      }
      const ts = awayRows.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t));
      const span = ts.length > 1 ? (Math.max(...ts) - Math.min(...ts)) / 1000 : 0;
      // docs/DATASET_README.md: "Several days of purchases in one new region is
      // a trip, not a clone." Same 36h shape test as detect_patterns.gsql.
      const tripLike = awayRegions.size === 1 && span > 36 * 3600;
      const where =
        awayRegions.size === 1 ? `region ${regionLabel([...awayRegions.keys()][0])}` : `${awayRegions.size} regions`;
      const base =
        `Card-present activity in this window is away from the card's usual region ${pre.regions.map(regionLabel).join("/")} ` +
        `(${baseDesc}): ${where} (${awayRows.length} transaction(s))` +
        (homeRecent > 0 ? `, alongside ${homeRecent} at home` : ", with none at home");
      if (tripLike) {
        add(
          `${base}; the away activity is one region over ${(span / 3600).toFixed(0)}h, the shape of a trip ` +
            "rather than a cloned card",
          [],
          0.3,
          awayRows,
          ["out_of_region_use"],
        );
      } else {
        const w = flaggedAwayFromPreHome ? (awayRegions.size >= 2 ? 0.75 : 0.65) : 0.5;
        add(base, ["out_of_region_use"], w, awayRows);
      }
    }
  }
  // No pre-window card-present history: the window is the only reference
  // there is, used with the guards it always had.
  const flaggedAtHome = !pre && flaggedInPerson && homeRegion !== undefined && flagged?.addr1 === homeRegion[0];
  if (!pre && flaggedAtHome && homeRegion && flagged && regions.size > 1) {
    add(
      `The flagged transaction is in billing region ${regionLabel(homeRegion[0])}, the region this card is used in most ` +
        `(${homeRegion[1].length} of ${inPerson.length} card-present transactions in the window); ` +
        "a charge in the card's usual region does not fit out-of-region use",
      [],
      0.5,
      [flagged],
      ["out_of_region_use"],
    );
  }
  // Away-region activity only argues for out_of_region_use when the flagged
  // charge is itself away from the card's usual region (or its location is
  // unknown to this window). It used to fire whenever a second region existed,
  // which in the same measurement supported out_of_region_use on 59% of
  // account_takeover and 40% of cleared cases; gated on the flagged charge it
  // fires on 72% of out_of_region_use, 11% of account_takeover and 10% of
  // cleared cases.
  if (!pre && regions.size > 1 && homeRegion && (flagged === undefined || (flaggedInPerson && !flaggedAtHome))) {
    const away = sortedRegions.slice(1);
    const awayRows = away.flatMap(([, rs]) => rs);
    // Same shape test as detect_patterns.gsql, so the two sources agree.
    // docs/DATASET_README.md: "Several days of purchases in one new region is
    // a trip, not a clone." Two or more away regions cannot be one trip; one
    // away region is read by how long it lasted. This item used to score 0.7
    // on any second region, which named out_of_region_use on ordinary travel.
    const spanSeconds = (rs: TxnRow[]): number => {
      const ts = rs.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t));
      return ts.length > 1 ? (Math.max(...ts) - Math.min(...ts)) / 1000 : 0;
    };
    const TRIP_SECONDS = 36 * 3600;
    const singleAwaySpan = away.length === 1 ? spanSeconds(awayRows) : 0;
    const tripLike = away.length === 1 && singleAwaySpan > TRIP_SECONDS;
    const where = away.length === 1 ? `region ${regionLabel(away[0]?.[0])}` : `${away.length} regions`;
    const base =
      `Card-present activity spans ${regions.size} billing regions in this window: ${where} ` +
      `(${awayRows.length} transaction(s)) alongside continuing activity in ${regionLabel(homeRegion[0])} (${homeRegion[1].length})`;
    if (tripLike) {
      add(
        `${base}; the away activity is one region over ${(singleAwaySpan / 3600).toFixed(0)}h, ` +
          "the shape of a trip rather than a cloned card",
        [],
        0.3,
        awayRows,
        ["out_of_region_use"],
      );
    } else {
      add(base, ["out_of_region_use"], away.length >= 2 ? 0.7 : 0.55, awayRows);
    }
  }

  const mismatched = rows.filter((r) => mismatchCount(r) >= 2);
  const online = rows.filter((r) => r.channel === "online").length;
  const offline = rows.length - online;
  if (mismatched.length > 0 && online > 0 && offline > 0) {
    // Failing identity match checks mark card-present fraud in general, not a
    // takeover in particular: detect_patterns' match-flag gate fires on 80% of
    // closed out_of_region_use cases against 66% of account_takeover (22%
    // cleared, 12-17% card-not-present). This item used to support only
    // account_takeover, which named takeovers on out-of-region cases. Where the
    // flagged charge sits against the pre-window home decides between the two.
    // When the flagged charge itself was online, the failing card-present
    // charges describe other activity on the card; they stay as context.
    const supports =
      flagged?.channel === "online"
        ? []
        : flaggedAtPreHome
          ? ["account_takeover"]
          : flaggedAwayFromPreHome
            ? ["out_of_region_use"]
            : ["account_takeover", "out_of_region_use"];
    add(
      `Mixed-channel activity (${online} online, ${offline} card-present) with ` +
        `${mismatched.length} transaction(s) failing two or more identity match checks`,
      supports,
      0.7,
      mismatched,
    );
  }
  return items;
}

function txnHistoryEvidence(
  data: unknown,
  idGen: EvidenceIdGen,
  asOf: string,
  flaggedTxnId?: string,
): EvidenceItem[] {
  const d = data as {
    rows?: TxnRow[];
    stats?: { count?: number; total_amount_usd?: number; window?: string };
    baseline_home?: BaselineHome;
  } | null;
  if (!d?.rows?.length) return [];
  const rows = d.rows;
  const small = rows.filter((r) => r.amount_usd < 5 && r.channel === "online");
  const large = rows.find((r) => r.amount_usd >= 100);
  const highRisk = rows.filter((r) => r.risk_score >= 0.3);

  let summary: string;
  let weight: number;
  const supports: string[] = [];
  if (small.length >= 3 && large) {
    summary =
      `${small.length} small online authorizations (${small.map((r) => `$${r.amount_usd.toFixed(2)}`).join(", ")}) ` +
      `followed by a $${large.amount_usd.toFixed(2)} purchase in a product code this card does not routinely use`;
    weight = 0.7;
    supports.push("card_testing");
  } else if (highRisk.length === 1) {
    const r = highRisk[0];
    if (!r) {
      summary = `${rows.length} transactions in ${d.stats?.window ?? "the tracked window"}`;
      weight = 0.3;
    } else {
      // Every clause here is computed from the rows. This branch used to assert
      // "online", "a product code this card has not used" and "no burst" without
      // checking any of them, and backed card_not_present_fraud with the claim --
      // on any card whose window held exactly one transaction the bank's model
      // scored >= 0.3, cleared cases included. The score only chooses which
      // transaction to describe ("a reason to look, never a verdict",
      // docs/DATASET_README.md); the pattern claim needs the facts that define it.
      const at = Date.parse(r.ts);
      const prior = rows.filter(
        (o) => o.txn_id !== r.txn_id && Number.isFinite(at) && Date.parse(o.ts) < at,
      );
      const online = r.channel === "online";
      const newProduct = prior.length > 0 && !prior.some((o) => o.product_cd === r.product_cd);
      const where = online ? "online" : r.channel === "in_person" ? "card-present" : `${r.channel || "unknown-channel"}`;
      const productClause =
        prior.length === 0
          ? `product code ${r.product_cd}, with no earlier activity in the window to compare it against`
          : newProduct
            ? `product code ${r.product_cd}, which none of this card's ${prior.length} earlier transactions in the window used`
            : `product code ${r.product_cd}, which this card has used earlier in the window`;
      // The high-risk row is not necessarily the charge the case is about. On
      // CC-5194 it was a card-present $150.01 purchase while the disputed charge
      // was online, and the old line ("Single $150.01 card-present purchase")
      // read as a description of the flagged charge, contradicting the pattern
      // shape item beside it. Say which transaction it is, and let only the
      // flagged charge's own facts back a pattern.
      const otherThanFlagged = flaggedTxnId !== undefined && r.txn_id !== flaggedTxnId;
      summary = otherThanFlagged
        ? `Single transaction in the window the bank's model scored 0.3 or higher is not the flagged charge: ` +
          `txn ${r.txn_id}, a $${r.amount_usd.toFixed(2)} ${where} purchase in ${productClause}`
        : `Single $${r.amount_usd.toFixed(2)} ${where} purchase in ${productClause}`;
      if (online && newProduct && !otherThanFlagged) {
        weight = 0.4;
        supports.push("card_not_present_fraud");
      } else {
        weight = 0.3;
      }
    }
  } else {
    summary = `${rows.length} transactions in ${d.stats?.window ?? "the tracked window"}`;
    weight = 0.3;
  }
  return [
    {
      id: idGen.next("get_transaction_history"),
      category: "txn_behavior",
      summary,
      entities: rows.map((r) => ref("Transaction", r.txn_id)),
      source_tool: "get_transaction_history",
      weight_hint: weight,
      supports,
      contradicts: [],
      ts: asOf,
    },
    ...discriminatingEvidence(rows, idGen, asOf, flaggedTxnId, d.baseline_home),
  ];
}

function velocityEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { count?: number; window_minutes?: number; total_amount_usd?: number } | null;
  if (!d || d.count === undefined) return [];
  // A raw count over a window is context, not a verdict: with no baseline in
  // the payload there is nothing to say whether it is high for this card. This
  // item used to support "fraud" at 0.45 whatever the count, so three ordinary
  // purchases in a day were filed as fraud evidence on every case. Bursts that
  // actually mean something (small-then-large, 2-4 online in 48h) are named by
  // detect_patterns and the txn-history detectors, which do have the shape.
  return [
    {
      id: idGen.next("compute_velocity"),
      category: "txn_behavior",
      summary: `${d.count} transaction(s) totaling $${(d.total_amount_usd ?? 0).toFixed(2)} in the last ${d.window_minutes} minutes`,
      entities: [],
      source_tool: "compute_velocity",
      weight_hint: 0.2,
      supports: [],
      contradicts: [],
      ts: asOf,
    },
  ];
}

// Fewest prior transactions a z-score is read from. With 2-3 priors the
// standard deviation is noise: CC-0589's two priors ($49.96, $50.05) gave
// std $0.045 and a $99.98 charge z=1110. A sample-size floor, not a threshold
// fitted to cases.
const MIN_BASELINE_PRIORS = 10;

function baselineEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { amount_z?: number; geo_z?: number; device_z?: number; time_z?: number; n_prior?: number } | null;
  if (!d) return [];
  // Older recordings carry no n_prior; they keep the old reading.
  if (typeof d.n_prior === "number" && d.n_prior < MIN_BASELINE_PRIORS) {
    return [
      {
        id: idGen.next("get_baseline_deviation"),
        category: "txn_behavior",
        summary:
          `The card has only ${d.n_prior} prior transaction(s) before this one, too few for an amount ` +
          "baseline; no deviation from the cardholder's usual spending is claimed either way",
        entities: [],
        source_tool: "get_baseline_deviation",
        weight_hint: 0.1,
        supports: [],
        contradicts: [],
        ts: asOf,
      },
    ];
  }
  const strong = d.amount_z !== undefined && d.amount_z >= 2;
  // The summary is what the model reads. It used to open "Transaction deviates
  // from cardholder baseline" on both branches, so a charge inside the card's
  // normal range was still described as a deviation even while the item's
  // `contradicts` said otherwise.
  const zs = `amount z=${d.amount_z?.toFixed(1) ?? "n/a"}, device z=${d.device_z?.toFixed(1) ?? "n/a"}`;
  return [
    {
      id: idGen.next("get_baseline_deviation"),
      category: "txn_behavior",
      summary: strong
        ? `Transaction deviates from cardholder baseline: ${zs}`
        : `Transaction is within the cardholder's usual amount range: ${zs}`,
      entities: [],
      source_tool: "get_baseline_deviation",
      weight_hint: strong ? 0.5 : 0.3,
      supports: strong ? ["fraud"] : [],
      contradicts: strong ? [] : ["fraud"],
      ts: asOf,
    },
  ];
}

/**
 * Evidence that merely shows *something is wrong* carries the generic label
 * "fraud", never a named pattern. `evidenceTopPattern` deliberately skips
 * "fraud"/"legitimate" when choosing a pattern, so generic signals vote on the
 * verdict without voting on the diagnosis.
 *
 * This used to be `card_testing` at nearly every site — velocity bursts, shared
 * rings, baseline deviation, community incidence, neighbourhood breadth, any
 * prior confirmed case — which made it the de facto synonym for "fraudulent".
 * The 2026-09-22 backtest against `closed_cases_history.csv` showed the cost:
 * card_testing is 16 of 4665 confirmed-fraud cases in the real data (0.3%), yet
 * the agent named it in 13 of 14 non-legitimate verdicts, holding pattern
 * accuracy to 19%. A named pattern now comes only from something that actually
 * identifies it: the small-authorizations-then-large-purchase detector above,
 * `detect_patterns`' own `pattern_id`, or a prior case's recorded pattern.
 */
/** Specific shared profiles needed before shared identifiers count as fraud evidence. */
const MIN_SHARED_PROFILES_FOR_RING = 3;
/** A New-device online charge this close to a known-device flagged one reads as the same new-device episode. */
const NEW_DEVICE_EPISODE_MINUTES = 30;

function ringsEvidence(
  data: unknown,
  idGen: EvidenceIdGen,
  asOf: string,
  seedCardId?: string,
): EvidenceItem[] {
  const d = data as { rings?: Array<{ shared_type: string; shared_id: string; card_ids: string[] }> } | null;
  const rings = d?.rings ?? [];
  if (rings.length === 0) {
    // Recorded fixtures emit a (weak) device_identity item even when no
    // shared link exists — the absence of a link is itself evidence, and it
    // contradicts the single-outlier fraud hypotheses (legitimate-leaning).
    return [
      {
        id: idGen.next("find_shared_entity_rings"),
        category: "device_identity",
        summary: "No shared device, address, or email links this card to any other account",
        entities: [],
        source_tool: "find_shared_entity_rings",
        weight_hint: 0.2,
        supports: ["legitimate"],
        contradicts: ["fraud"],
        ts: asOf,
      },
    ];
  }
  const items = rings.map((ring): EvidenceItem => {
    const entities = [ref(sharedTypeEntityType(ring.shared_type), ring.shared_id), ...ring.card_ids.map((c) => ref("Card", c))];
    // card_ids includes the seed card itself (shared_rings.gsql), so counting
    // it would report a card as sharing a device with itself — HHG-011 filed
    // 420 items reading "with 1 other cards" for devices no one else used.
    const others = seedCardId ? ring.card_ids.filter((c) => c !== seedCardId) : ring.card_ids;
    // A ring larger than MAX_CORROBORATING_RING_SIZE is a fingerprint crowd,
    // not a fraud ring (sharedOrigin.ts) — HHG-001's 45-card device profile
    // is the canonical example. Report the fact, but don't let it read as
    // fraud-supporting; that call is left to the corroboration check
    // (assessSharedOrigin), not to raw ring size alone. Every ring is still
    // itemised: how widely a card is connected is itself evidence (README,
    // "Devices and regions connect people"), so it is never dropped to save
    // prompt space — the context window is sized to fit instead.
    if (ring.card_ids.length > MAX_CORROBORATING_RING_SIZE) {
      return {
        id: idGen.next("find_shared_entity_rings"),
        category: "device_identity",
        summary:
          `Shares ${sharedTypeLabel(ring.shared_type)} ${ringIdLabel(ring)} with ${others.length} other cards — ` +
          `too large a group to be a specific fraud ring; likely a common device/region fingerprint`,
        entities,
        source_tool: "find_shared_entity_rings",
        weight_hint: 0.15,
        supports: [],
        contradicts: [],
        ts: asOf,
      };
    }
    // An email "ring" links cards through an EmailDomain vertex, and the
    // dataset only carries domains (docs/DATASET_README.md: "Purchaser and
    // recipient email domains"). Six cards on yahoo.com.mx share a webmail
    // provider, not an identity. It is still itemised -- a rare or disposable
    // domain is worth the model's attention, and lookup_external classifies
    // it -- but it cannot support fraud on its own the way a shared device
    // profile can. It did, at 0.65, on every case whose recipient domain was
    // popular.
    if (ring.shared_type === "email") {
      return {
        id: idGen.next("find_shared_entity_rings"),
        category: "device_identity",
        summary:
          `Recipient email domain ${ring.shared_id} is also used by card(s) ${others.join(", ")} — ` +
          "a shared domain, not a shared address, so this identifies a provider rather than a person",
        entities,
        source_tool: "find_shared_entity_rings",
        weight_hint: 0.2,
        supports: [],
        contradicts: [],
        ts: asOf,
      };
    }
    // Each shared device/address profile is itemised as context; the weight
    // is carried once, by the aggregate item below. Every ring used to be its
    // own 0.65 fraud item, so a card sharing ten profiles filed ten votes for
    // one fact -- cleared alert CC-1660 reached p=0.90 that way.
    return {
      id: idGen.next("find_shared_entity_rings"),
      category: "device_identity",
      summary: `Activity shares ${sharedTypeLabel(ring.shared_type)} ${ringIdLabel(ring)} with card(s) ${others.join(", ")}`,
      entities,
      source_tool: "find_shared_entity_rings",
      weight_hint: 0.15,
      supports: [],
      contradicts: [],
      ts: asOf,
    };
  });
  const specific = rings.filter(
    (r) => r.shared_type !== "email" && r.card_ids.length <= MAX_CORROBORATING_RING_SIZE,
  );
  if (specific.length === 0) return items;
  // Measured on 60 cleared and 60 confirmed-fraud closed cases at their own
  // opened_at (shared_rings defaults, email excluded): three or more specific
  // shared profiles on 67% of fraud cases vs 20% of cleared; one or two on
  // 10% of fraud vs 47% of cleared. A handful of shared profiles is what a
  // household or a common device looks like, so it is not fraud evidence.
  const linked = [...new Set(specific.flatMap((r) => r.card_ids.filter((c) => c !== seedCardId)))];
  const broad = specific.length >= MIN_SHARED_PROFILES_FOR_RING;
  items.push({
    id: idGen.next("find_shared_entity_rings"),
    category: "device_identity",
    summary: broad
      ? `Card's activity in the last 30 days shares ${specific.length} device profiles / billing regions with ` +
        `${linked.length} other card(s) active in the same window -- a web of shared identifiers, not a single shared device`
      : `Card shares only ${specific.length} device profile(s) / billing region(s) with ${linked.length} other card(s) -- ` +
        "the kind of overlap a household or a common device produces",
    entities: linked.map((c) => ref("Card", c)),
    source_tool: "find_shared_entity_rings",
    weight_hint: broad ? 0.6 : 0.2,
    supports: broad ? ["fraud"] : [],
    contradicts: [],
    ts: asOf,
  });
  return items;
}

/**
 * Detectors that describe card-present fraud. detect_patterns scores the whole
 * card (its signature takes no transaction), so on a card with ordinary
 * card-present history these can fire while the charge under investigation
 * is online. By definition out_of_region_use is card-present (0 of 955
 * closed cases flagged online), and so are 93% of account_takeover cases.
 */
const CARD_PRESENT_PATTERNS = new Set(["account_takeover", "out_of_region_use"]);

// Evidence weight for a detector hit, keyed by pattern and the GSQL score tier
// it fired at. The weight used to be `min(0.85, 0.3 + score)`, which read the
// tier as if it were the probability the detector is right. Measured on 319
// held-out closed cases (stratified by gold pattern, excluding the 20-case
// backtest sample; /tmp/hhgoa-run/detprec.py) the tiers are far less reliable
// than that: account_takeover@0.8 names the right pattern 36% of the time
// (52 of its 121 hits are out_of_region_use), out_of_region_use@0.8 32%,
// card_not_present_new_device@0.65 33%. Only card_testing is sharp (0.71).
// Each weight is that precision shrunk toward 0.35 with k=5, so the two
// small tiers (n=2, n=4) are not taken at face value. A tier missing from the
// table (a future detector change) falls back to the same prior rather than
// to the raw score.
const DETECTOR_TIER_WEIGHT: Record<string, Record<string, number>> = {
  account_takeover: { "0.45": 0.22, "0.8": 0.36 },
  card_not_present_fraud: { "0.4": 0.28, "0.8": 0.4 },
  card_not_present_new_device: { "0.65": 0.33, "0.85": 0.22 },
  card_testing: { "0.55": 0.54, "0.9": 0.56 },
  out_of_region_use: { "0.3": 0.53, "0.65": 0.41, "0.8": 0.33 },
  // The amount-structuring burst: 3 of 3 hits right on the closed cases it was
  // designed from (0 of 33 look-alikes fire), shrunk toward 0.35 with k=5.
  undocumented: { "0.85": 0.59 },
};
const DETECTOR_PRIOR_WEIGHT = 0.35;

// Detector tiers that fire at least as often on cleared alerts as on
// confirmed fraud. Measured on an LLM-free gather of 150 cleared + 150
// confirmed-fraud closed cases outside the 50-case backtest sample (live,
// un-muted hits only): card_not_present_fraud@0.40 fired on 47 cleared vs 30
// fraud, card_not_present_new_device@0.65 on 44 vs 23, @0.85 on 7 vs 2. They
// say which online pattern a fraud would be, not that fraud occurred, so they
// keep their pattern weight but are not an independent fraud signal for R1.
// (Cleared cases are almost all model alerts, so part of this is the alert
// selecting online bursts; either way the hit does not separate the classes.)
const NON_DISCRIMINATING_DETECTOR_TIERS = new Set([
  "card_not_present_fraud@0.4",
  "card_not_present_new_device@0.65",
  "card_not_present_new_device@0.85",
]);
const DETECTOR_SUMMARY = /^Pattern "([a-z_]+)" detected with score ([\d.]+)/;

/** A detect_patterns hit whose tier does not separate fraud from cleared alerts. */
export function isNonDiscriminatingDetector(e: Pick<EvidenceItem, "summary" | "source_tool">): boolean {
  if (e.source_tool !== "detect_patterns") return false;
  const m = DETECTOR_SUMMARY.exec(e.summary);
  if (!m) return false;
  const tier = String(Math.round(Number(m[2]) * 100) / 100);
  return NON_DISCRIMINATING_DETECTOR_TIERS.has(`${m[1]}@${tier}`);
}

export function detectorWeight(patternId: string, score: number): number {
  const tier = String(Math.round(score * 100) / 100);
  return DETECTOR_TIER_WEIGHT[patternId]?.[tier] ?? DETECTOR_PRIOR_WEIGHT;
}

function patternsEvidence(
  data: unknown,
  idGen: EvidenceIdGen,
  asOf: string,
  flaggedChannel?: string,
): EvidenceItem[] {
  const d = data as { patterns?: Array<{ pattern_id: string; score: number; evidence: string[] }> } | null;
  if (!d) return [];
  if (!d.patterns?.length) {
    // The detectors ran and none of the five documented patterns fired. This
    // used to be stated as a vote for `legitimate` at 0.45. Measured on 319
    // held-out closed cases, no detector fires on 32% of cleared cases but on
    // 48% of card_not_present_fraud and card_not_present_new_device cases --
    // a miss is *more* common on those frauds than on cleared alerts, so it is
    // not exculpatory. It is recorded as the finding it is, voting for nothing.
    return [
      {
        id: idGen.next("detect_patterns"),
        category: "policy_match",
        summary:
          "Graph pattern detectors ran against the card's history and none of the five documented " +
          "fraud patterns matched (card_testing, card_not_present_fraud, card_not_present_new_device, " +
          "out_of_region_use, account_takeover); the detectors cover only those documented shapes, so " +
          "a miss neither shows the activity is legitimate nor rules any pattern out",
        entities: [],
        source_tool: "detect_patterns",
        weight_hint: 0.2,
        supports: [],
        contradicts: [],
        ts: asOf,
      },
    ];
  }
  return d.patterns.map((p): EvidenceItem => {
    // A card-present detector hit on a card whose flagged charge was online
    // describes the card's other activity, not the charge under investigation.
    // It stays in the record as context; it no longer outvotes the channel.
    // CC-3430 (gold card_not_present_fraud, flagged online) was named
    // account_takeover because this hit (0.85) plus the mixed-channel claim
    // (0.7) outweighed the online channel item (0.5).
    if (flaggedChannel === "online" && CARD_PRESENT_PATTERNS.has(p.pattern_id)) {
      return {
        id: idGen.next("detect_patterns"),
        category: "policy_match",
        summary:
          `Pattern "${p.pattern_id}" detected with score ${p.score.toFixed(2)} on the card's history ` +
          `(txn(s) ${p.evidence.join(", ")}), but it describes card-present activity and the flagged ` +
          "charge was online, so it does not describe the charge under investigation",
        entities: [],
        source_tool: "detect_patterns",
        weight_hint: 0.2,
        supports: [],
        contradicts: [],
        ts: asOf,
      };
    }
    if (p.pattern_id === "undocumented") {
      return {
        id: idGen.next("detect_patterns"),
        category: "policy_match",
        summary:
          `Amount-structuring burst: ${p.evidence.length} online charges within one hour, every one between ` +
          `$400 and $500 with differing amounts (txn(s) ${p.evidence.join(", ")}); none of the five ` +
          "documented patterns describes charges sized just under a round amount",
        entities: [],
        source_tool: "detect_patterns",
        weight_hint: detectorWeight(p.pattern_id, p.score),
        supports: ["undocumented"],
        contradicts: [],
        ts: asOf,
      };
    }
    return {
      id: idGen.next("detect_patterns"),
      category: "policy_match",
      summary: `Pattern "${p.pattern_id}" detected with score ${p.score.toFixed(2)} on txn(s) ${p.evidence.join(", ")}`,
      entities: [],
      source_tool: "detect_patterns",
      weight_hint: detectorWeight(p.pattern_id, p.score),
      supports: [p.pattern_id],
      contradicts: [],
      ts: asOf,
    };
  });
}

function communityEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as {
    community_id?: string;
    size?: number;
    stats?: { confirmed_fraud_rate?: number; n_cases?: number; population_confirmed_fraud_rate?: number };
  } | null;
  if (!d?.community_id) return [];
  const rate = d.stats?.confirmed_fraud_rate ?? 0;
  const nCases = d.stats?.n_cases;
  const population = d.stats?.population_confirmed_fraud_rate;
  // The rate is over the community's closed cases, and most closed cases are
  // cardholder disputes, so it reads high nearly everywhere. It used to
  // support fraud at any rate >= 40%; CC-0955 (cleared) drew that vote from a
  // 1,186-entity community at 48%, below the closed-case history as a whole.
  // It now counts only when the community's cases resolve as fraud more often
  // than all cases closed by the same as_of do. The population rate is used
  // here and never printed: it is how cases in the history resolve, which is
  // not something the assessor should anchor on.
  //
  // A one-entity community is the card by itself: its closed cases are the
  // card's own, which find_prior_cases already reports under prior_cases. It
  // used to vote again here as "community" evidence -- the same fact counted
  // twice toward R1's independent signals (31 of 150 held-out cleared alerts).
  const alone = d.size !== undefined && d.size <= 1;
  const comparable = !alone && nCases !== undefined && nCases > 0 && population !== undefined && population > 0;
  const enriched = comparable && rate > population;
  const cases = nCases !== undefined ? ` across ${nCases} closed case(s)` : "";
  const reading = alone
    ? ", but the community is this card alone, so these are the card's own cases (see prior cases), not a community signal"
    : !comparable
    ? ""
    : enriched
      ? ", more often than closed cases resolve as fraud generally"
      : ", no more often than closed cases resolve as fraud generally, so this is not a fraud signal";
  return [
    {
      id: idGen.next("get_community"),
      category: "graph_structure",
      summary:
        `Card sits in community ${d.community_id} (${d.size ?? "?"} entities) with confirmed-fraud ` +
        `incidence ${(rate * 100).toFixed(0)}%${cases}${reading}`,
      entities: [],
      source_tool: "get_community",
      weight_hint: enriched ? 0.45 : 0.2,
      supports: enriched ? ["fraud"] : [],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function neighborhoodEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { nodes?: Array<{ type: string; id: string }> } | null;
  if (!d?.nodes?.length) return [];
  const neighborIds = d.nodes.filter((n) => n.type !== "Card" || true).map((n) => `${n.type}:${n.id}`).join(", ");
  return [
    {
      id: idGen.next("get_neighborhood"),
      category: "graph_structure",
      summary: `Neighborhood exposes ${neighborIds}`,
      entities: d.nodes.map((n) => ref(n.type, n.id)),
      source_tool: "get_neighborhood",
      weight_hint: 0.35,
      supports: ["fraud"],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function priorCasesEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { cases?: Array<{ case_id: string; outcome: string; pattern: string; own?: boolean }> } | null;
  const cases = d?.cases ?? [];
  if (cases.length === 0) {
    // Absence of prior cases is (weak) evidence worth recording.
    return [
      {
        id: idGen.next("find_prior_cases"),
        category: "prior_cases",
        summary: "No prior fraud or cleared cases found for this customer or card",
        entities: [],
        source_tool: "find_prior_cases",
        weight_hint: 0.1,
        supports: [],
        contradicts: [],
        ts: asOf,
      },
    ];
  }
  const fa = cases.filter((c) => c.outcome === "confirmed_fraud");
  const fc = cases.filter((c) => c.outcome === "cleared");
  // find_prior_cases marks a case `own` when it is about this card or its
  // customer. Measured on 150 cleared + 150 confirmed-fraud closed cases, the
  // cited fraud was the card's own history in 43/43 and 107/110 hits; the text
  // says whose fraud it is rather than implying another card's.
  const whose = (cs: typeof fa): string => {
    if (cs.every((c) => c.own === undefined)) return "";
    const own = cs.filter((c) => c.own === true).length;
    if (own === cs.length) return " on this card or customer";
    if (own === 0) return " on connected card(s) of other customers";
    return ` (${own} on this card or customer, ${cs.length - own} on connected cards)`;
  };
  const summary = fa.length
    ? `Prior confirmed fraud case(s)${whose(fa)} ${fa.map((c) => c.case_id).join(", ")} (pattern ${fa.map((c) => c.pattern).join("/")})` +
      (fc.length ? `; cleared case(s) ${fc.map((c) => c.case_id).join(", ")}` : "")
    : `Only cleared prior case(s): ${fc.map((c) => c.case_id).join(", ")}`;
  // Every pattern the cited fraud carried, not the first-listed one: the first
  // matched gold on 310/540 held-out multi-prior cases, the set on 439/540.
  const faPatterns = [...new Set(fa.map((c) => c.pattern || "fraud"))];
  return [
    {
      id: idGen.next("find_prior_cases"),
      category: "prior_cases",
      summary,
      entities: cases.map((c) => ref("ClosedCase", c.case_id)),
      source_tool: "find_prior_cases",
      weight_hint: fa.length ? 0.5 : 0.1,
      supports: fa.length ? faPatterns : ["legitimate"],
      contradicts: fa.length ? [] : ["fraud"],
      ts: asOf,
    },
  ];
}

/**
 * The agent sends no narrative, so retrieve_similar_cases ranks on entity
 * overlap alone: a shared card or customer scores ~0.30, a shared amount band
 * alone ~0.03. Below this floor the "precedent" matched on amount band only,
 * and the top-k is filled with whichever cases sort first -- on a probe of
 * three backtest cases that was always CC-0001, CC-0002, CC-0006. Those say
 * nothing about this case and are not offered as memory.
 */
const MIN_PRECEDENT_SCORE = 0.1;

function similarCasesEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { cases?: Array<{ case_id: string; score: number; outcome: string; overlap_reason: string }> } | null;
  const cases = (d?.cases ?? []).filter((c) => c.score >= MIN_PRECEDENT_SCORE);
  if (!cases.length) return [];
  return cases.map((c): EvidenceItem => ({
    id: idGen.next("retrieve_similar_cases"),
    category: "prior_cases",
    summary: `Similar closed case ${c.case_id} (score ${c.score.toFixed(2)}, ${c.outcome}): ${c.overlap_reason}`,
    entities: [ref("ClosedCase", c.case_id)],
    source_tool: "retrieve_similar_cases",
    // A precedent is worth as much as it resembles this case, whichever way
    // it was resolved. The weight used to be a flat 0.5 for a fraud precedent
    // and 0.15 for a cleared one regardless of score: 84% of closed cases are
    // confirmed fraud, so retrieval already returns mostly fraud precedents,
    // and the asymmetry stacked a second fraud bias on top of the base rate.
    weight_hint: Math.round(Math.min(0.5, 0.5 * c.score) * 100) / 100,
    supports: c.outcome === "confirmed_fraud" ? ["fraud"] : ["legitimate"],
    contradicts: c.outcome === "confirmed_fraud" ? [] : ["fraud"],
    ts: asOf,
  }));
}

/**
 * The undocumented cross-card device ring (CHALLENGE_BRIEF: "Not every fraud
 * pattern present in the data is documented"; docs/DATASET_README.md R9). One
 * device, reached through an anonymous proxy and presenting as new every time,
 * used by many unrelated cards in the 30 days up to as_of. The flagged
 * charge's device carries these counts on its get_entity_profile row.
 *
 * Thresholds are measured, not chosen: on every closed case, a flagged charge
 * whose device has >=5 cards with >=80% anonymous-proxy and >=80% "New" uses
 * fires on 4 of the 9 undocumented cases and on none of the other 5,556 --
 * including 0 of 900 cleared. The rings it finds hold 20-24 cards at 100% on
 * both shares, and the nearest non-ring device reaches 4 cards at 60%, so the
 * cut sits in a wide gap rather than on a knife edge. Raw sharing is not the
 * signal: about 89% of every class shares the flagged device with 2+ cards.
 */
export const PROXY_RING_MIN_CARDS = 5;
export const PROXY_RING_MIN_SHARE = 0.8;

export interface ProxyDeviceRing {
  device_id: string;
  cards: number;
  uses: number;
  anon_share: number;
  new_share: number;
}

/** The ring the flagged charge's device belongs to, or null when it is not one. */
export function readProxyDeviceRing(attrs: Record<string, unknown>): ProxyDeviceRing | null {
  const device_id = String(attrs["device_id"] ?? "").trim();
  const cards = Number(attrs["device_cards_30d"]);
  const uses = Number(attrs["device_uses_30d"]);
  const anon = Number(attrs["device_anon_proxy_uses_30d"]);
  const fresh = Number(attrs["device_new_uses_30d"]);
  if (!device_id || ![cards, uses, anon, fresh].every(Number.isFinite) || uses <= 0) return null;
  const ring = { device_id, cards, uses, anon_share: anon / uses, new_share: fresh / uses };
  if (ring.cards < PROXY_RING_MIN_CARDS) return null;
  if (ring.anon_share < PROXY_RING_MIN_SHARE || ring.new_share < PROXY_RING_MIN_SHARE) return null;
  return ring;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** R9 asks for the pattern "in your own words"; this is the one place they are written. */
export function describeProxyDeviceRing(ring: ProxyDeviceRing): string {
  return (
    `One device (${ring.device_id}) reached ${ring.cards} different cards in the 30 days to the case ` +
    `(${ring.uses} uses), ${pct(ring.anon_share)} of them through an anonymous proxy and ` +
    `${pct(ring.new_share)} presenting as a new device -- coordinated use of a single device across ` +
    `unrelated customers, which none of the five documented patterns describes`
  );
}

/**
 * The amount-structuring burst detect_patterns reports as `undocumented`
 * (4+ online charges inside an hour, each in [$400, $500)), in our own words.
 * Amounts and times come from the case's own history rows; when a detector
 * txn is missing from them the text says only what the rule guarantees.
 */
export function describeStructuringBurst(
  txnIds: readonly string[],
  rows: ReadonlyArray<{ txn_id: string; ts: string; amount_usd: number }>,
  cardId?: string,
): string {
  const ids = new Set(txnIds);
  const hits = rows.filter((r) => ids.has(r.txn_id)).sort((a, b) => a.ts.localeCompare(b.ts));
  const card = cardId ? `card ${cardId}` : "the card";
  const tail =
    "Each charge sits just under $500 and the amounts differ, as if sized to stay below a round " +
    "limit; it is not a card-testing run (no small probes) and none of the five documented " +
    "patterns describes it. Found by the graph's burst check on the card's own history.";
  if (hits.length !== ids.size || hits.length === 0) {
    return `${ids.size} online charges on ${card} within one hour, each between $400 and $500. ${tail}`;
  }
  const minutes = Math.round((Date.parse(hits[hits.length - 1]!.ts) - Date.parse(hits[0]!.ts)) / 60000);
  const amounts = hits.map((r) => `$${r.amount_usd.toFixed(2)}`).join(", ");
  return `${hits.length} online charges on ${card} within ${minutes} minutes (${amounts}). ${tail}`;
}

function profileEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as {
    entity?: EvidenceEntityRef;
    attributes?: Record<string, unknown>;
  } | null;
  if (!d?.entity) return [];
  const attr = d.attributes ?? {};
  // A transaction profile carries the device-ring counts. It is fetched for
  // the flagged charge only, and everything else on it is already in the
  // history evidence, so the ring is the only claim worth filing -- and only
  // when there is one. Filing a bare "profile" item would add an evidence
  // category (raising the confidence cap) while saying nothing.
  if ("device_cards_30d" in attr) {
    const ring = readProxyDeviceRing(attr);
    if (!ring) return [];
    return [
      {
        id: idGen.next("get_entity_profile"),
        category: "device_identity",
        summary:
          `${describeProxyDeviceRing(ring)}. The flagged charge was made on this device. ` +
          `In the closed-case history this device signature fired on 4 cases, all confirmed fraud of the ` +
          `undocumented type, and on none of the other 5,561 -- a small sample, so it is reported as strong ` +
          `graph evidence rather than proof`,
        entities: [d.entity, { type: "Device", id: ring.device_id }],
        source_tool: "get_entity_profile",
        weight_hint: 0.9,
        supports: ["undocumented"],
        contradicts: ["legitimate"],
        ts: asOf,
      },
    ];
  }
  return [
    {
      id: idGen.next("get_entity_profile"),
      category: "graph_structure",
      summary: `Profile for ${d.entity.type} ${d.entity.id}: ${Object.keys(attr).join(", ")}`,
      entities: [d.entity],
      source_tool: "get_entity_profile",
      weight_hint: 0.2,
      supports: [],
      contradicts: [],
      ts: asOf,
    },
  ];
}

function lookupExternalEvidence(data: unknown, idGen: EvidenceIdGen, asOf: string): EvidenceItem[] {
  const d = data as { kind?: string; value?: string; enrichment?: Record<string, unknown> } | null;
  if (!d?.kind) return [];
  return [
    {
      id: idGen.next("lookup_external"),
      category: "external",
      summary: `External ${d.kind} "${d.value}": ${Object.entries(d.enrichment ?? {})
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ")}`,
      entities: [],
      source_tool: "lookup_external",
      weight_hint: 0.2,
      supports: [],
      contradicts: [],
      ts: asOf,
    },
  ];
}