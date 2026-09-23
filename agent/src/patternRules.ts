import type { EvidenceItem, Hypothesis } from "@hhgoa/contracts";
import { isPatternShape } from "./evidenceBuilder.js";

/**
 * docs/DATASET_README.md defines pattern 3 by one field: "Card-not-present
 * fraud from a new device. Same as above, with the identity record marking the
 * device as `New` for this account". So when the flagged online charge carries
 * id_15 = New, a card-not-present reading of the case is the new-device
 * pattern, not plain card-not-present fraud.
 *
 * The data agrees with the definition. On the Kev export's 1,419 held-out
 * closed fraud cases, the new-device shape item is present on 289 of 400
 * card_not_present_new_device cases, 6 of 234 account_takeover cases, and none
 * of 400 card_not_present_fraud cases. The evidence already says so (the item
 * supports the new-device pattern and contradicts plain CNP), but the local
 * assessor names card_not_present_fraud anyway -- CC-5194 (iteration 13) cited
 * the item for new-device at 0.30 and filed CNP at 0.65.
 *
 * The same holds for the episode: a known-device flagged charge with a New-device
 * online charge within 30 minutes of it (evidenceBuilder.ts) carries the same
 * supports/contradicts and triggers the same move -- held-out, new-device is the
 * majority pattern in that shape.
 *
 * Only this one move is made: plain CNP's mass goes to the new-device pattern.
 * Account takeover and the rest are left alone, and the fraud total does not
 * change, so this never touches the verdict -- it corrects which pattern the
 * fraud reading names.
 */
export interface NewDeviceRule {
  hypotheses: Hypothesis[];
  moved: number;
  item: string;
}

function flaggedNewDeviceItem(evidence: readonly EvidenceItem[]): EvidenceItem | undefined {
  return evidence.find(
    (e) =>
      isPatternShape(e) &&
      e.supports.includes("card_not_present_new_device") &&
      e.contradicts.includes("card_not_present_fraud"),
  );
}

export function applyNewDeviceRule(
  hypotheses: readonly Hypothesis[],
  evidence: readonly EvidenceItem[],
): NewDeviceRule | null {
  const cnp = hypotheses.find((h) => h.fraud_type === "card_not_present_fraud");
  if (!cnp || cnp.probability <= 0) return null;
  const item = flaggedNewDeviceItem(evidence);
  if (!item) return null;
  const moved = cnp.probability;
  const target = hypotheses.find((h) => h.fraud_type === "card_not_present_new_device");
  const out: Hypothesis[] = [];
  for (const h of hypotheses) {
    if (h.fraud_type === "card_not_present_fraud") continue;
    if (h.fraud_type === "card_not_present_new_device") {
      out.push({
        ...h,
        probability: h.probability + moved,
        supporting: [...new Set([...h.supporting, item.id, ...cnp.supporting])],
      });
    } else {
      out.push({ ...h });
    }
  }
  if (!target) {
    out.push({
      fraud_type: "card_not_present_new_device",
      probability: moved,
      supporting: [...new Set([item.id, ...cnp.supporting])],
      contradicting: [],
    });
  }
  return { hypotheses: out, moved, item: item.id };
}

/**
 * The channel rule. docs/DATASET_README.md defines out_of_region_use as
 * "card-present purchases in a billing region the cardholder has no history
 * in", so a fraud whose flagged charge was online is not that pattern by
 * definition. account_takeover is "mixed-channel activity" -- not card-present
 * by definition, but card-present in practice: of the ~2,590 closed
 * confirmed-fraud cases whose flagged charge was online, 84 (3.2%) were account
 * takeovers and none out-of-region (evidenceBuilder.ts, channel item); on the
 * 540-case held-out gather, 9 of 209 and 0.
 *
 * The evidence already says so (the channel item contradicts both), but the
 * pattern scorer named account_takeover on three online-flagged cases in the
 * 50-case backtest (iteration 18), on the strength of card-level detectors and
 * prior cases that cannot see the flagged charge. So when a card-present
 * pattern tops an online-flagged case, its mass moves to the strongest
 * card-not-present reading (card_not_present_fraud if none has any); the
 * new-device rule then runs as before. The fraud total is unchanged, so the
 * verdict is never touched. Accepted cost: the ~3% of online-flagged fraud that
 * really is account takeover.
 */
export interface ChannelRule {
  hypotheses: Hypothesis[];
  moved: number;
  from: string;
  to: string;
  item: string;
}

const CARD_PRESENT_PATTERNS = new Set(["account_takeover", "out_of_region_use"]);
const CNP_FAMILY = ["card_not_present_fraud", "card_not_present_new_device", "card_testing"] as const;

function onlineChannelItem(evidence: readonly EvidenceItem[]): EvidenceItem | undefined {
  return evidence.find(
    (e) =>
      isPatternShape(e) &&
      e.supports.includes("card_not_present_fraud") &&
      e.contradicts.includes("account_takeover") &&
      e.contradicts.includes("out_of_region_use"),
  );
}

export function applyChannelRule(
  hypotheses: readonly Hypothesis[],
  evidence: readonly EvidenceItem[],
): ChannelRule | null {
  const documented = hypotheses.filter((h) => h.fraud_type !== "legitimate" && h.fraud_type !== "undocumented");
  const top = [...documented].sort((a, b) => b.probability - a.probability)[0];
  if (!top || top.probability <= 0 || !CARD_PRESENT_PATTERNS.has(top.fraud_type)) return null;
  const item = onlineChannelItem(evidence);
  if (!item) return null;
  const cp = hypotheses.filter((h) => CARD_PRESENT_PATTERNS.has(h.fraud_type));
  const moved = cp.reduce((s, h) => s + h.probability, 0);
  const cnp = hypotheses
    .filter((h) => (CNP_FAMILY as readonly string[]).includes(h.fraud_type) && h.probability > 0)
    .sort((a, b) => b.probability - a.probability)[0];
  const to = cnp?.fraud_type ?? "card_not_present_fraud";
  const carried = [item.id, ...cp.flatMap((h) => h.supporting)];
  const out: Hypothesis[] = [];
  for (const h of hypotheses) {
    if (CARD_PRESENT_PATTERNS.has(h.fraud_type)) continue;
    out.push(
      h.fraud_type === to
        ? { ...h, probability: h.probability + moved, supporting: [...new Set([...h.supporting, ...carried])] }
        : { ...h },
    );
  }
  if (!out.some((h) => h.fraud_type === to)) {
    out.push({ fraud_type: to, probability: moved, supporting: [...new Set(carried)], contradicting: [] });
  }
  return { hypotheses: out, moved, from: top.fraud_type, to, item: item.id };
}
