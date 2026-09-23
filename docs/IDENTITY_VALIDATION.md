# Identity vertex validation

PRD §12 asks for the purity and merge rate of the `Identity` vertex, measured against the real
customer ids. This is that report.

## What is being validated

`Identity` is a derived actor key: `hash(card1, addr1, estimated first-transaction day)`, built by
WS1's loading job (`graph/scripts/prepareLoadFiles.ts` header, `graph/schema.gsql`). Each `Card`
links to identities through `RESOLVES_TO` edges. The dataset's own `customer_id` on each card is
the ground truth the key should match.

Two measures, as defined in `gsql/scripts/_identity_validation.gsql`:

- **Purity:** for each `Identity`, the share of its linked cards that belong to its single most
  common customer, weighted by the number of links. 100% means no identity ever mixes customers.
- **Split rate:** the share of customers whose cards resolve to more than one `Identity`, i.e.
  cases where the key failed to merge one person's cards.

## Results

Run against the full loaded graph on 2026-09-23 (install, run once, drop; the query is not part
of the regular query install pipeline):

| Measure | Value |
|---|---|
| Card-to-identity links (`RESOLVES_TO`) | 39,568 |
| Identities | 37,531 |
| Identities spanning more than one customer | 0 |
| **Purity** (majority links / all links) | **100%** (39,568 / 39,568) |
| Customers | 12,066 |
| Customers split across more than one identity | 4,601 |
| **Split rate** | **38.1%** |

These match the numbers first recorded when WS2 wrote this report (`docs/logs.md`, WS2
section). That first version of this file was never committed and was lost with its worktree;
this is a re-run, not a copy.

## What it means

- The key **never falsely merges** two customers: no identity contains another customer's card.
- It **often fails to merge** one customer's cards: over a third of customers are split across
  several identities.
- So `Identity` is safe to use as evidence that two cards belong together, but its absence says
  little. The agent's ring and community logic does not rely on `Identity` as a single-actor key:
  `community_lookup.gsql` and `get_community` build the shared-entity component directly from
  devices, addresses and emails (`docs/logs.md`, WS2 section).

## Reproducing

The query text is `gsql/scripts/_identity_validation.gsql`. It declares local variables inside a
`FOREACH` loop, which TigerGraph 4.3.0-rc1 rejects in interpreted mode, so it has to be
installed, run once, then dropped. With the repo's helper (`gsql/scripts/gsqlExec.ts`, which reads the credentials
from `.env`):

```ts
import { runGsqlFile, runGsqlCmd } from "./gsql/scripts/gsqlExec.ts";
const g = { graph: "hhgoa_fraud" };
runGsqlFile("identity_validation.gsql", g); // the query text without its leading // comments
runGsqlCmd("INSTALL QUERY identity_validation", g);
console.log(runGsqlCmd("RUN QUERY identity_validation()", g).stdout);
runGsqlCmd("DROP QUERY identity_validation", g);
```
