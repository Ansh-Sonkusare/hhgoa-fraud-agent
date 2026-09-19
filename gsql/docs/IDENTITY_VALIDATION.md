# Identity validation

WS1's `Identity` vertex (`graph/schema.gsql`) is a heuristic actor-resolution
key: `hash(card1, addr1, est_first_day)`, built at load time and linked to
`Card` via the `RESOLVES_TO` edge. This document measures how well that
heuristic actually groups cards belonging to the same real customer, using
`Card.customer_id` (the dataset's real customer identifier) as ground
truth, and records the implications for tools that lean on `Identity`
(`community_lookup.gsql`, `shared_rings.gsql`, `get_community`).

## Method

Ran a one-off analysis query (`gsql/scripts/_identity_validation.gsql`, not
part of the regular `install.ts` pipeline) over the full loaded dataset
(16,324 cards, 37,531 `Identity` vertices, 12,066 distinct customers with at
least one `RESOLVES_TO` edge). For every `Card -RESOLVES_TO-> Identity`
edge, it tallies:

- **purity** — for each `Identity`, whether the cards resolving to it all
  share one `customer_id`, or are split across more than one. This is
  card-weighted: an identity's contribution to the overall purity score is
  `majority_customer_card_count`, summed and divided by the total resolved
  cards.
- **split rate** — for each real customer, whether their cards all resolve
  to the *same* `Identity`, or are spread across more than one.

## Results

| Metric | Value |
|---|---|
| Cards with >= 1 `RESOLVES_TO` edge | 13,239 |
| Total `RESOLVES_TO` edges | 40,367 |
| `Identity` vertices touched | 37,531 |
| Distinct customers touched | 12,066 |
| **Purity** (card-weighted) | **100%** (0 identities span more than one customer) |
| **Customer split rate** | **38.1%** (4,601 / 12,066 customers have their cards spread across more than one `Identity`) |
| Cards with more than one `RESOLVES_TO` edge | most of the 13,239 (40,367 edges / 13,239 cards ~= 3.0 edges/card) |

## Interpretation

**Purity is perfect: the heuristic never merges two different customers
into one identity.** No `Identity` vertex was found with cards from more
than one `customer_id`. `hash(card1, addr1, est_first_day)` is specific
enough that two unrelated customers never collide on it in this dataset.
This means any tool that treats "same `Identity`" as "same real customer"
will never produce a false-positive cross-customer link from `Identity`
alone.

**But the heuristic badly under-merges: it's not a stable per-customer key.**
Two separate effects both push in this direction:

1. **38.1% of customers are split across multiple identities.** A
   customer's different cards (different `card1`/`addr1` combinations, or
   different `est_first_day` values) hash to different `Identity` vertices,
   even though they're the same real person. `Identity` should be read as
   "one hashed fingerprint of one card-attribute combination," not "one
   real actor" — a single actor can and often does have several.
2. **A single card frequently resolves to *multiple* `Identity` vertices**
   (~3 `RESOLVES_TO` edges per card that has any, on the 13,239 cards that
   resolve at all). This wasn't anticipated from the schema comment alone
   and is a further fragmentation signal on top of (1) — even fixing a
   single card's identity doesn't pin down one canonical actor key.

## Implications for WS2's tools

- **`community_lookup.gsql` / `get_community` do not use `Identity` at
  all** — they compute the connected component over the
  `CARD_DEVICE`/`CARD_ADDRESS`/`CARD_RECIPIENT_EMAIL` sharing projection
  directly (see `docs/decisions.md`), which is a different (structural)
  notion of "shared identity" than the `Identity` hash. Given the 38.1%
  split rate and the multi-`Identity`-per-card fragmentation above, that
  was the right call: `Identity` alone is not a reliable single key for
  "who is this."
- **`resolve_trigger.gsql` returns `Identity` informationally** (one
  resolved id via `RESOLVES_TO`, picked deterministically by `MinAccum`
  when a card has more than one edge) but callers should treat it as "a"
  fingerprint for this card's current attributes, not "the" canonical
  identity for the underlying person — consistent with the purity/split
  findings above.
- A future improvement (not built here, given time — noted for whoever
  picks this back up) would be to treat `RESOLVES_TO` as a *union-find*
  input: two cards sharing *any* `Identity` (even if each also has other,
  non-shared identities) are likely the same actor. That's a strictly
  looser and probably more useful signal than requiring cards to resolve
  to exactly the same single `Identity` id, and would directly address the
  split-rate finding above.

## Reproducing

```bash
docker cp gsql/scripts/_identity_validation.gsql hhgoa-tigergraph:/tmp/identity_validation.gsql
docker exec hhgoa-tigergraph /home/tigergraph/tigergraph/app/cmd/gsql \
  -u tigergraph -p tigergraph -g hhgoa_fraud -f /tmp/identity_validation.gsql
docker exec hhgoa-tigergraph /home/tigergraph/tigergraph/app/cmd/gsql \
  -u tigergraph -p tigergraph -g hhgoa_fraud "INSTALL QUERY identity_validation"
curl -s -u tigergraph:tigergraph -X POST \
  http://localhost:9000/query/hhgoa_fraud/identity_validation -d '{}'
```
