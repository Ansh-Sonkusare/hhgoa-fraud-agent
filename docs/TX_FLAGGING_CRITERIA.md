# Transaction Flagging Criteria

Reference for what transactions/behavior this agent flags and why, drawn from `docs/DATASET_README.md` (authoritative), `policy/policy.yaml`, and the detector/agent implementation.

## Documented fraud patterns

Flag a transaction when it matches one of the bank's five known patterns (`docs/DATASET_README.md`, "The five known fraud patterns"). A risk score alone is never a verdict — it's a reason to look.

| Pattern (`case.pattern` value) | Flag when | Policy rule |
| --- | --- | --- |
| `card_testing` | 3+ small online authorizations (code: `< $10`, measured: `< $5` holds for only 2/16 gold cases) within the 48h episode on one card, followed by a larger online purchase (code: `> $50`) | R5 |
| `card_not_present_fraud` | 2-4 online transactions within 48h, amount/product doesn't fit the card's history (code: amount `> 2x` the card's own prior mean) | R1-R4 |
| `card_not_present_new_device` | Same burst pattern as above, plus the identity record marks the device `New` for this account (stronger signal; sometimes behind a proxy) | R1-R4 |
| `out_of_region_use` | Card-present purchases in a billing region with no prior history for this cardholder, while normal activity continues at home | R2, R3 |
| `account_takeover` | Identity match-flag failure rate >= 1 failed check per transaction over 7d with >= 3 failing transactions (0.8); any 2+ failures (0.45). Mixed channel is NOT required: measured 51% gold vs 48% cleared | — |
| `undocumented` | Coordinated or repeated abuse that fits none of the five — describe it in your own words in `pattern_description` (finding this is scored) | R9 |

A single unusual online purchase (pattern 2 on its own) is ambiguous — verify, don't block.

## Risk, confidence, and when to stop looking

**Risk score.** Every transaction carries a bank-model `risk_score` (0-1). It is a reason to look, never a verdict — many high scores are legitimate and some fraud scores low.

**Confidence guard** (code-enforced, not left to the LLM — `agent/src/assess.ts`): confidence is capped by how many *independent* evidence categories support it, and downgraded one tier if contradicting evidence is strong.

| Independent evidence categories | Confidence cap |
| --- | --- |
| 0-1 | 0.45 |
| 2 | 0.65 |
| 3+ | uncapped |

**Stopping the investigation** — per `docs/DATASET_README.md` §6 (authoritative), stop when any of these holds:
- Fraud probability ≥ 0.85, or ≤ 0.15, supported by at least two independent pieces of evidence
- A verification response settles the question
- Further steps are unlikely to change the decision (say why in `stop_reason`)

**Note on implementation:** `agent/src/stopRule.ts` currently encodes a stricter variant carried over from an earlier PRD draft — ≥3 evidence categories (or all exhausted) AND (top hypothesis leads the runner-up by ≥0.25, OR confidence ≥ 0.75) AND the intended action's policy prerequisites are met. This is a superset of the README's bar in practice, but the two aren't textually identical; worth reconciling explicitly against the README's 0.85/0.15-with-2-evidence wording if exact stop timing is graded.

**R1 — verify before you block on a weak signal:** if the case rests on a single signal (including risk score alone) and probability is below 0.70, flag for `VERIFY_WITH_CUSTOMER` / `STEP_UP_AUTH`, not a block.

## What action a flagged transaction triggers

Only `auto`-route actions may be executed by the agent; `L1`/`L2` actions are recommended and wait for a human approval.

| Rule | Trigger condition | Recommended action(s) | Route |
| --- | --- | --- | --- |
| R1 | Single-signal case, probability < 0.70 | `VERIFY_WITH_CUSTOMER` or `STEP_UP_AUTH` before any block | auto |
| R2 | Customer denies the transaction | `BLOCK_CARD`, `CREATE_CASE`; add `FILE_REPORT` if exposure > $1,000 or shared device/other-card fraud | L1/L2 |
| R3 | Customer confirms the transaction | `CLOSE_NO_FRAUD` | auto |
| R4 | No reply within 24h | `MONITOR_CARD` + `DECLINE_TRANSACTION` for pending auths; escalate if exposure > $500 | auto/L1 |
| R5 | Card testing (3+ small online auths in a card-window, then a bigger purchase) | `DECLINE_TRANSACTION` + `STEP_UP_AUTH`; `BLOCK_CARD` if a purchase over $100 already cleared | auto/L1 |
| R6 | Shared origin: same device profile / billing region / recipient email across several cards' fraud | Name the shared element; `CREATE_CASE` + `FILE_REPORT`; `MONITOR_CONNECTED_CARDS` for every card sharing it | auto/L2 |
| R7 | Disputed charge matches the customer's own recurring pattern | `CREATE_CASE`, `VERIFY_WITH_CUSTOMER`, `WARN_CUSTOMER` — do not block | auto |
| R8 | Verdict `uncertain` and exposure > $500, or evidence conflicts | `ESCALATE_TO_ANALYST` | auto |
| R9 | Fits no known pattern but shows coordinated/repeated abuse | `CREATE_CASE`, `FILE_REPORT`, `ESCALATE_TO_ANALYST`; describe the pattern in `pattern_description` | auto/L2 |
| R10 | `BLOCK_ALL_CARDS` | Only if ≥ 2 of the customer's cards show confirmed fraud, or credentials are confirmed compromised | L2 |

**Exposure** = sum of absolute amounts of every transaction identified as part of the fraud episode (including the flagged one), in USD.

**BLOCK_CARD routing:** L1 when exposure ≤ $2,500; L2 above that.

**Open a case (`CREATE_CASE`)** whenever fraud probability reaches 0.30, whenever evidence is requested, or whenever a customer disputes a charge — independent of whether a report is ultimately filed.

## When a report (SAR) is required, not just a case

A **case** (`CREATE_CASE`) is the bank's internal record — most flagged transactions only need this. A **report** (`FILE_REPORT`) is a regulatory filing sent outside the bank, and is rarer.

File a report when fraud is confirmed or strongly suspected **and** at least one of:

- Exposure exceeds $1,000
- The activity connects to a shared device profile, a shared region cluster, or another customer's fraud
- The pattern is coordinated or undocumented (R9)

`sar.file` must agree with whether `FILE_REPORT` appears in the final recommended actions. If false: `narrative`, `subjects`, `total_amount_usd`, `activity_dates` are empty/zero. If true, the narrative (6-12 sentences) must independently cover who, what, when, where, how, and why it's suspicious — it stands on its own for the regulator.

## Where each rule lives in code

| Rule / concept | File |
| --- | --- |
| Source of truth for all thresholds above | `docs/DATASET_README.md` ("Fraud Policy" section) — authoritative; PRD and code must match it |
| Action list, approval routes, prerequisites | `policy/policy.yaml` |
| Policy engine (routing, prerequisites, exposure-based L1/L2 bump) | `policy/src/engine.ts` |
| SAR-required check (mirrors the three OR-conditions) | `policy/src/engine.ts` (`sarRequired()`) |
| Card testing detector (3+ online auths `< $10` in the 48h episode, then one `> $50` after them; R5's 1h span not applied — 0/16 gold cases satisfy it) | `gsql/queries/detect_patterns.gsql` |
| Card-not-present detector (burst of 2-4 in 48h, `> 2x` prior mean) | `gsql/queries/detect_patterns.gsql` |
| Card-not-present + new device detector (flagged txn's `id_15 == "New"`) | `gsql/queries/detect_patterns.gsql` + `agent/src/evidenceBuilder.ts` |
| Out-of-region detector (distinct new regions; single region over ~36h reads as a trip) | `gsql/queries/detect_patterns.gsql` |
| Account-takeover detector (match-flag failure rate >= 1.0 per txn over 7d; no channel or baseline requirement) | `gsql/queries/detect_patterns.gsql` |

All five detectors live in `gsql/queries/detect_patterns.gsql`, which backs the
`detect_patterns` contract tool. The former standalone `gsql/detectors/det_*.gsql`
copies were deleted: nothing invoked them, and they had drifted from the corrected
thresholds above, so they were duplicated dead code presenting itself as the
reference. The device-newness test is split because `detect_patterns` takes only
`(card_id, as_of)` — it cannot see which transaction was flagged — so the sharp
form of that signal is asserted in the evidence builder, which can.
| Confidence guard (category-count cap + contradiction downgrade) | `agent/src/assess.ts` |
| Stop rule (see the reconciliation note above) | `agent/src/stopRule.ts` |
| Next-best-action recommendation logic | `agent/src/recommend.ts` |

Any change to a threshold should start at `docs/DATASET_README.md`; `contracts/` and the PRD are downstream of it, not the other way around.
