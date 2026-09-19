# Data map

Reconciliation of `docs/DATASET_README.md` (authoritative for files, columns, patterns, policy, and the graded answer format) into the shape code will actually be written against. If this file and the dataset README ever disagree, the dataset README wins and this file gets fixed — never the other way around.

## Files

| File | Rows | Key columns | Notes |
|---|---|---|---|
| `transactions.csv` | 590,742 | `TransactionID`, `TransactionDT`, `TransactionAmt`, `ProductCD`, `card1`-`card6`, `addr1`, `addr2`, `dist1`, `dist2`, `P_emaildomain`, `R_emaildomain`, `C1`-`C14`, `D1`-`D15`, `M1`-`M9`, `V1`-`V339`, `customer_id`, `ts`, `channel`, `risk_score` | No fraud flag. ~708MB. `customer_id` derived from card issuer field. `channel` = `in_person` (ProductCD `W`, no identity row) or `online` |
| `identity.csv` | 144,432 | `TransactionID` (FK), `id_01`-`id_38`, `DeviceType`, `DeviceInfo` | Online transactions only, joins to `transactions.csv` on `TransactionID` |
| `closed_cases_history.csv` | 5,565 | `case_id`, `customer_id`, `card_id`, `opened_at`, `closed_at`, `outcome` (`confirmed_fraud`/`cleared`), `pattern`, `first_fraud_txn_id`, `txn_ids` (pipe-separated), `n_txns`, `exposure_usd`, `connected_card_ids`, `actions_taken`, `report_filed`, `analyst_notes` | July-Oct 2016. 4,665 confirmed fraud, 900 cleared. This is the labeled history and the agent's starting case memory |
| `case_pack.csv` | 20 | `case_id`, `opened_at`, `trigger_type` (`risk_score`/`customer_report`/`analyst_request`), `trigger_text`, `flagged_txn_id`, `card_id`, `customer_id`, `risk_score` (risk-score triggers only) | Nov-Dec 2016. The 20 benchmark cases, also in README's "The 20 Cases" table |

Disguised fields (new IDs, small time/amount offsets, to prevent lookup against the public Kaggle file): `TransactionID`, `card1`, `TransactionDT`, `TransactionAmt`. Everything else untouched. **Never join back to the public IEEE-CIS/Kaggle files** — disqualifying per README Rules.

## Column reference (unnamed groups — treat as signals, cite honestly in evidence)

| Group | Count | What we know |
|---|---|---|
| `card1`-`card6` | 6 | `card4`=network (visa/mastercard/amex/discover), `card6`=type (credit/debit), rest are issuer codes |
| `C1`-`C14` | 14 | Counts (e.g. addresses/phones associated with the card). Individually unnamed |
| `D1`-`D15` | 15 | Time deltas in days (e.g. days since previous transaction). Individually unnamed |
| `M1`-`M9` | 9 | Match flags (e.g. name-on-card matches address). Individually unnamed |
| `V1`-`V339` | 339 | Vesta engineered features. Unnamed. Lives in DuckDB per PRD §7, not loaded as graph attributes |
| `id_01`-`id_11` | 11 | Encoded ratings: device rating, IP-domain rating, proxy rating, login counts, time on page |
| `id_12`-`id_38` | 27 | Categorical identity fields. Readable: `id_15` (device New/Found), `id_23` (proxy: transparent/anonymous/hidden), `id_30` (OS), `id_31` (browser), `id_33` (screen), `id_34` (match status) |

Do not claim to know what an individual `V*`/`C*`/`D*`/`M*` column means. Reference it as "engineered feature Vn" or "count feature Cn" in evidence.

## The five documented fraud patterns → `case.pattern` enum

| `pattern` value | README name | Signature |
|---|---|---|
| `card_testing` | Card testing | ≥3 tiny online auths (often <$5), then a larger purchase. Policy R5 |
| `card_not_present_fraud` | Card-not-present fraud | Amount/product doesn't fit history, burst of 2-4 within 48h. Policy R1-R4 |
| `card_not_present_new_device` | CNP from a new device | Same as above + identity record marks device `New` (`id_15`), sometimes proxy (`id_23`) |
| `out_of_region_use` | Out-of-region use | Card-present purchases in a billing region (`addr1`) with no history there, while home activity continues. Policy R2, R3 |
| `account_takeover` | Account takeover | Mixed-channel activity inconsistent with cardholder, device/match-flag anomalies |
| `undocumented` | — | Fits none of the five; `pattern_description` required (2-3 sentences) |
| `none` | — | Legitimate |

## Answer format — binding shape

The full JSON shape, field types, and the worked example live in `docs/DATASET_README.md` under "Answer Format" and are reproduced verbatim as the target contract in **PRD.md §13**. Do not duplicate the shape a third time here — read PRD §13 for the schema and the dataset README for field-by-field meaning. Summary of what must never drift:

- Output: `cases/<case_id>.json`, one per line in `case_pack.csv`, 20 files total.
- Three parts per file: `case` (internal record), `sar` (regulatory filing, only when `FILE_REPORT` is recommended), `next_best_actions` (`initial` before any evidence request, `final` after).
- `case.pattern` must be one of the seven enum values above.
- Every ID referenced (`affected_txn_ids`, `connected_card_ids`, `similar_prior_cases`, etc.) must exist in the dataset — fabricated IDs score zero.

## Policy actions → `next_best_actions[].action` enum

`ALLOW_TRANSACTION` · `DECLINE_TRANSACTION` · `MONITOR_CARD` · `MONITOR_CONNECTED_CARDS` · `WARN_CUSTOMER` · `VERIFY_WITH_CUSTOMER` · `STEP_UP_AUTH` · `BLOCK_CARD` · `BLOCK_ALL_CARDS` · `GENERATE_REPORT` · `CREATE_CASE` · `FILE_REPORT` · `ESCALATE_TO_ANALYST` · `CLOSE_NO_FRAUD`

Approval routes: `auto` (agent may execute), `L1` (team lead: `DECLINE_TRANSACTION`, `BLOCK_CARD` ≤$2,500 exposure), `L2` (fraud manager: `BLOCK_CARD` >$2,500, `BLOCK_ALL_CARDS`, `FILE_REPORT`, always).

Rules R1-R10 and the case-vs-report distinction (§3a) are in README's Fraud Policy section — cite the rule number in every `reason` field, don't restate the rule text in code comments or here.

## Open items for WS1 (graph) once it starts

- [ ] Confirm final vertex/edge attribute list against this map before writing `schema.gsql` (PRD §7 is a starting point, not frozen)
- [ ] Record actual MCP tool names in `docs/MCP_TOOLS.md` once TigerGraph MCP is connected
