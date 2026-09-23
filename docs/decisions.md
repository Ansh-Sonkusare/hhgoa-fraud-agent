# Decisions log

One entry per decision that wasn't already dictated by `PRD.md`/`docs/DATASET_README.md`. Newest first. Each entry: what was decided, why, and what it overrides (if anything).

## 2026-09-20 — LLM backend: add OpenAI-compatible client for llama.cpp (`LLM_BACKEND=openai`)
**Context:** the user built a local CUDA llama.cpp (`llama-server -hf Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M ... --host 0.0.0.0 --port 8080`) and wants the agent to use it for real end-to-end runs. llama.cpp's `llama-server` speaks the OpenAI-compatible `/v1/chat/completions` protocol, **not** Ollama's `/api/chat`, so pointing `OLLAMA_HOST` at `:8080` would not work.
**Decided:** a new `OpenAiCompatLlmClient` in `agent/src/llm.ts` talking to `{baseUrl}/v1/chat/completions` (`LLM_BACKEND=openai`; `LLM_BASE_URL` default `http://localhost:8080`; `LLM_MODEL` falls back to `OLLAMA_MODEL`), gated exactly like the other backends: `createLlmClient("openai")`, `eval/src/runner.ts`'s `runModeFromEnv`/`preflight` (preflight hits `/v1/models`), and `api/src/liveRunSource.ts`. `jsonMode` maps to OpenAI `response_format: { type: "json_object" }` (llama.cpp grammar-backed), `temperature` maps directly, and usage maps `prompt_tokens`/`completion_tokens`. This also covers any other OpenAI-compatible host (vLLM, TGI, etc.), so Groq-style fallbacks need no separate client. Tests stay on `MockLlmClient`/injected `fetchFn` (new `tests/ws4/llm.test.ts` cases); the live `:8080` server is never required by `make test`.
**Field observation (first real run, HHG-007):** the assessor call is a single `structuredCall` whose brief is **12,678 tokens** (system prompt + compact evidence). `llama-server` started with `-c 4096` then 400s `exceed_context_size_error` and the case aborted. The client now surfaces the server's error body ("server said: …") on non-2xx instead of a bare HTTP status, and the required context is documented: **run llama.cpp with `-c 32768`** (KV cache ≈ 3.7 GB at 16k × 4 slots; ≈ 7 GB at 32k) so the assessment and its evidence/repair rounds fit.

## 2026-09-20 — WS4: `shared_origin_connection` requires a corroborated common actor, not any shared attribute

**Problem (measured, not hypothesised):** the policy's `shared_origin_connection` was computed as `facts.rings.some(r => r.card_ids.length > 1)` (`agent/src/caseState.ts`) — "this card shares *some* attribute with *some* other card". Combined with `MAX_PLAUSIBLE_RING_SIZE = 50` (`agent/src/mcpClient.ts`), a real run produced a ring of 29-47 cards through a coarse `DeviceProfile` fingerprint (`DeviceInfo + OS + browser + screen`), unioning to 533 "connected cards" and forcing `FILE_REPORT` under R6 on a case whose only shared element was a collision. Policy §3a/R6 defines the field as connecting to a shared device/region/**another card's fraud**; the code only tested the first clause, and never the "fraud" part.

**Decided — corroboration, not attribute-sharing.** `shared_origin_connection` is now `plausible_ring && (prior_confirmed_fraud || community_confirmed)`:
- **`plausible_ring`** — a ring of `2..MAX_CORROBORATING_RING_SIZE` (**10**). Chosen from measurement: the three genuine discovered components are 5/5/9 cards while the observed noise bands are 29-47 (HHG-007) and 45 (HHG-001). `mcpClient.ts`'s 50 cap stays as the transport-level sentinel guard; 10 is the evidence bar.
- **`prior_confirmed_fraud`** — a `find_prior_cases` hit with `outcome = "confirmed_fraud"` (already in the compact sweep). §3a's literal "another customer's fraud".
- **`community_confirmed`** — `get_community` reports `size >= 2` **and** `confirmed_fraud_rate >= COMMUNITY_FRAUD_RATE_MIN` (**0.90**). The bar deliberately equals the discovery pass's `min_confirmed_pct = 90`: the graph's genuine clusters sit at 100%, the rejected 274-card volume artifact at 81.6% (below the 83.2% dataset baseline). This is the "is this a *genuine* cluster" question, answered by the graph's own WCC, not re-derived from raw ring sizes.

**Decided — a conditional second-opinion call (`runSharedOriginCorroboration`, `agent/src/investigation.ts`).** When the compact sweep found a plausible ring that prior fraud does not already corroborate, the machine makes exactly one extra graph call, `get_community` (backed by `community_lookup`, the same 2-distinct-types + overlap WCC as the discovery pass). Short-circuits when there is no plausible ring or prior confirmed fraud already corroborates, so most cases pay nothing; `community_lookup` is a ~5-12s whole-graph computation when it does run. It is *not* part of `COMPACT_GATHER_STEPS` (the recorded fixtures never made the call) and it charges budget like every other graph tool.

**Decided — report only corroborated rings.** `connected_card_ids` / `connected_device_profiles` now derive from corroborated rings only (empty when not corroborated), matching the answer format's "other cards caught in the same compromise, ring, or device" and the sample answer. HHG-007's 533-card list becomes empty; a genuine 2-card link is unaffected. `recommend.ts`'s R6 reason now cites the actual corroborator ("another card's confirmed fraud" or "community of N cards at X% confirmed-fraud incidence") rather than always claiming "other card fraud".

**Rejected: a TS multi-type/entity-size bar.** `community_lookup`'s card-side guard is a Jaccard overlap on each card's *uncapped* footprint, and `addr1` is a billing *region* (332 values / 16,324 cards) / email a *domain* (60 values) — "popular" is their normal condition, so a TS size cap would both fail to reproduce the guard and kill legitimate address/email corroboration (docs/decisions.md, 2026-09-19). Delegating the "genuine cluster" decision to the graph avoids re-approximating it.

**Known limitation (accepted):** a first-time, single-type, device-only pair with no prior case and no multi-type community is not corroborated → `shared_origin_connection: false`. That is the hardest case, and it is handled the way the README handles ambiguity generally — "on its own, one unusual online purchase is ambiguous: verify" (DATASET_README, Card-not-present fraud) — so the machine's own signal assessment still governs: R1 (policy/src/engine.ts:77) routes weak single-signal cases to `VERIFY_WITH_CUSTOMER`/`STEP_UP_AUTH` before any block, rather than to a report.

**Tests:** `tests/ws4/sharedOrigin.test.ts` (unit: uncorroborated ring, prior-fraud, crowd-scale, community bar at exactly 0.90, plausibility at exactly 10; integration: `get_community` is called only when a plausible ring lacks prior-fraud corroboration). Full `make test` green (9 packages), `pnpm typecheck` clean, `make lint` clean. No `contracts/`, `policy/` or `gsql/` changes — corroboration reads existing fields (`CommunityData.stats` was already `Record<string, number>`).

## 2026-09-20 — WS7 submission-gap fix: investigation record in the answer file, and real case write-back to TigerGraph

The submission brief requires (a) the internal investigation record per case and (b) that "the case should also be written to the graph" as case memory the next investigation finds. The implementation fell short on both, so these were fixed (user-approved):

**`investigation_record` revived in the answer schema.** PRD §13 once retired an `investigation_record` draft field. The brief's requirement makes it a real deliverable again, so it is back — but defined precisely as the agent's own `AgentEvent` stream (PRD §8.5) in `seq` order, embedded verbatim, NOT a new bespoke shape. README's "*if this file and the README disagree, the README wins*" precedence still holds (the README's Answer Format table now documents it). `contracts/answerFile.ts` adds `investigation_record: AgentEvent[]`; the validator requires it non-empty with strictly increasing `seq`.

**`written_to_graph` stopped lying.** `machine.ts`'s `memoryUpdate()` set `written_to_graph: true` after closing the in-memory ledger only — nothing was ever written to TigerGraph. Now, under the real tool backend, after `assemble()` the machine calls an injected `persistCase` hook (MCP `upsert_case_record` query written by WS7 in `gsql/queries/` + the existing `rag.writeCaseToMemory`), then reports the actual result. The fake and in-memory backends stay honest (`written_to_graph: false`) rather than claim a write that didn't happen. The `FraudCase` vertex carries `source: "live"` so case memory is distinguishable from benchmark/closed-case data.

**Skip WS8 (demo video / blog / social media posts) for now** — user chose to defer rather than burn time.

**GSQL ground truth discovered (no source change, informs the query):** this CE build (4.3.0-rc1) has no `parse_json`, and query-level DML `INSERT`/`DELETE` accepts only positional `VALUES` (column lists trigger a bogus "no primary key" semantic error; one empty `ListAccum` satisfies a `LIST<DOUBLE>` column). All verified empirically against the live graph in `/tmp` before writing the real query, then cleaned up.

## 2026-09-19 — WS2 review findings: "cap at 3h" misreading, and missing discovery stats

A review pass on the community-detection work below (independent re-verification: reinstalled from a clean state, reran `tests/ws2/*.test.ts`, and spot-checked the headline numbers directly against the live graph) found two real issues, now fixed.

**"capped at 3h" was a misreading of the actual PRD text.** Both this codebase's earlier decision entries and the `discovery_report.gsql` header cited a "kickoff brief" phrase, "capped at 3h," and read it as a runtime behavior spec ("top 3 qualifying communities"). The actual `PRD.md` sec.12 text is: *"...become discovered patterns (written to Pattern with description). **Cap at 3 hours; hardcode what works.**"* Read in context (a hackathon PRD giving scoping advice throughout), this is a time-box instruction to the implementer — don't over-engineer this discovery pass, spend at most 3 hours on it and hardcode reasonable thresholds — not a spec for how many patterns the query should return. `discovery_report.gsql`'s top-3 cap is kept (a small, reviewable list of the strongest qualifying communities is still a reasonable design on its own merits), but the header comment's stated rationale was corrected — it no longer claims the PRD mandates exactly 3.

**PRD sec.12 explicitly requires four community-level stats — two were missing.** The PRD text: *"community-level stats (**size, velocity, shared-device density, risk-score distribution**) joined with closed-case outcomes."* `community_lookup.gsql` (backs `get_community`) had size, `avg_risk_score`, and `confirmed_fraud_rate`, but no `velocity` or `shared_device_density`. `discovery_report.gsql` had size and case counts, but no velocity, shared-device density, or risk score at all. Added to both:

- **`velocity`** = transactions per day of activity spanned by the community's members (total txns / max(1, days between earliest and latest member txn `ts`)). A single-day or single-txn community reports its raw txn count rather than dividing by a near-zero span.
- **`shared_device_density`** = device-touches per distinct device among the community's members (total `CARD_DEVICE` edges from members, filtered by the same entity-side `max_hub_degree` guard as the WCC itself, divided by the count of distinct devices those edges touch). 1.0 means every touched device is used by only one member (no internal reuse); higher values mean devices are reused across multiple members — a genuine density signal, not just a footprint count.
- **`risk-score distribution`** is summarized as `avg_risk_score` (already present in `community_lookup.gsql`; added to `discovery_report.gsql` too, for consistency). A full distribution doesn't fit the contract's flat `stats: Record<string, number>` shape (`contracts/src/tools.ts` `CommunityData`), so the mean is used, the same summarization choice made elsewhere in this codebase (`baseline_deviation.gsql`, the detectors).

Both new stats are computed with the same entity-side `max_hub_degree` guard as the rest of the WCC machinery, so a sentinel/default device doesn't inflate `shared_device_density` the way the ungated projection inflated the old single-guard WCC (see the entry below). Verified against the live graph: `discovery_report`'s three qualifying components now report `velocity`/`shared_device_density`/`avg_risk_score` alongside their existing stats (e.g. the 9-card component: 0.39 txns/day, density 2.17, avg risk 0.156). Two new tests added (`tests/ws2/communityAndCases.test.ts`, `tests/ws2/algorithmsAndDiscovery.test.ts`); `make verify-gsql` green, 44/44 (up from 42).

## 2026-09-19 — WS2 community detection: the residual component was a transaction-volume artifact, not a ring

Follow-up investigation into the 274-card residual component the previous entry left as an open question ("is 274 fine, or still too big?"). It was not fine. Investigating it before tuning anything changed the answer substantially — the fix is not a stricter version of the existing rule, and two of the four candidate directions previously floated are measurably counter-productive.

**What the 274-card component actually was.** Measured with a purpose-built diagnostic (now committed as `gsql/scripts/_community_sweep.gsql`, which carries the full sweep table in its header):

- Its 274 cards spanned 272 distinct customers and held **253,146 of the dataset's 590,742 transactions** — 43% of all activity on 1.7% of the cards. Members averaged **923.9 transactions** and a footprint of **138.6 distinct shared entities**, against dataset averages of **36.2 and 7.8**: a 17.8x enrichment in footprint.
- Its confirmed-fraud rate was **40/49 = 81.6%**, *at or slightly below* the **83.2% dataset-wide baseline** (4,473 confirmed of 5,373 closed cases with a recorded outcome). It was not fraud-enriched at all.
- Its connecting edges spanned the entire six-month window (2016-07-02 to 2016-12-31), and it was held together by 3,054 distinct device connectors rather than a handful of near-cap hubs.

So it was the set of the **most active cards in the dataset**, colliding with each other by volume. It was also the *only* thing `discovery_report` was emitting: exactly one discovered `Pattern`, that component, described to the agent as a fraud cluster.

**Root cause: the projection is bipartite and only one side was guarded.** `Card` on one side, `Device`/`Address`/`EmailDomain` on the other. There are two independent ways to manufacture a giant component and each needs its own guard. `max_hub_degree` guarded the *entity* side (a sentinel value touched by thousands of cards). Nothing guarded the *card* side: the probability that two cards happen to share some rare entity scales with the **product of how many entities each touches**, so the highest-volume cards collide with each other regardless of how tight the entity cap is. That is why sweeping `max_hub_degree` from 25 down to 3 shrank the residual but never removed it — it was tuning the wrong side.

**Decided: add a card-side guard, `min_overlap_pct` (default 30), and loosen `max_hub_degree` to 1000.** Two cards are adjacent only if they share 2+ distinct entity types (unchanged) **and** the entities they share are at least `min_overlap_pct`% of their *combined uncapped distinct-entity footprint* (a Jaccard bar). Using each card's full uncapped footprint as the denominator is the point: a card that touched 600 entities is not identified by having 2 of them in common with someone.

`max_hub_degree` was simultaneously loosened from 25 to 1000 because 25 was doing violent collateral damage as a proxy for the guard that was actually missing: it discards **59% of all `CARD_DEVICE` edges, 98% of all `CARD_ADDRESS` edges and 99% of all `CARD_RECIPIENT_EMAIL` edges**. That is worth stating plainly — `Address` is `addr1`, a billing **region** (332 distinct values for 16,324 cards), and `EmailDomain` is a **domain**, not an address (60 distinct values). Neither is ever an identifier on its own, so "popular" is their normal condition, not a defect to filter. The cap's only legitimate job is removing genuine sentinels, and exactly 20 vertices exceed degree 1000 (1 Device, 14 Address, 5 EmailDomain).

**Results (full dataset, `as_of` 2016-12-31):**

| | before | after |
|---|---|---|
| largest component | 274 cards | **41 cards** |
| largest component's avg txns / footprint per card | 923.9 / 138.6 | **4.7 / 4.9** (both *below* the dataset averages of 36.2 / 7.8) |
| multi-card components | 7 | **241** |
| total components | 16,042 | 15,825 |
| discovered `Pattern`s | 1 (274 cards, 81.6% confirmed — below baseline) | **3** (5, 5 and 9 cards; **11/11, 3/3 and 15/15 confirmed** = 100%) |

The decisive test is the second row: the largest component's members are now *less* active than an average card, i.e. the largest component has stopped being "the busiest cards," which is the structural signature of the artifact being gone.

**Rejected, having measured them rather than assumed:**

- **Require all 3 entity types instead of 2.** Makes the artifact *purer*, not smaller in character: the resulting 17-card component averaged **4,459 transactions and a 528.8 footprint** per card, and it produced **zero** components with enough connected cases for discovery to report anything. Three-type overlap is simply a rarer coincidence that only the very highest-volume cards can achieve — it selects harder *for* the failure mode.
- **Require temporal proximity of the shared usage.** Does not discriminate here. The artifact's members are active across the whole six-month window, so their usage intervals overlap trivially; a proximity bar would pass them.
- **Require 2+ shared *instances* of a type.** High-volume cards clear that bar easily for the same product-of-degrees reason, so it does not target the mechanism.
- **Leave it and document 274 as acceptable.** Not defensible once the fraud rate came back *below* baseline — shipping it means telling the agent a below-average cluster is a discovered fraud ring.

**Also decided: discovery's qualifying bar must beat the baseline (`min_confirmed_pct`, default 90 — was a hardcoded 50).** Independent of the clustering, this was a real defect. A `confirmed_fraud_rate >= 0.5` bar is **33 points below the 83.2% baseline**, so it is below chance: any cluster with cases at all passes, and "high confirmed-fraud concentration" was never actually being tested. The three communities discovery now reports are at 100%.

**Also fixed: `community_lookup.gsql` now computes the identical relation — the previous inconsistency was a live bug, not just an inconsistency.** The previous entry recorded leaving `community_lookup`/`shortest_path` on the looser single-type rule as "a documented inconsistency, not revisited." Revisiting it found a concrete defect: `discovery_report` writes Pattern ids as `disc_c_<smallest member card id>` and `community_lookup` synthesizes `comm_<smallest member card id>`, and both files' comments claimed the two therefore agree — but a *different adjacency rule yields a different component, hence a different smallest member*, so the ids silently did not match. The agent would get one membership from `get_community` and a different one from the discovered pattern for the same cluster. `community_lookup.gsql` now runs the same whole-graph computation and reads off the seed's label, which is the only way that invariant actually holds. There is now a regression test asserting it (`tests/ws2/algorithmsAndDiscovery.test.ts`).

**Cost accepted, deliberately:** `community_lookup` went from ~0.2s (cheap 3-hop local expansion) to **~5-12s** (whole-graph). That is a real regression for a per-call agent tool and it was weighed: a fast answer that disagrees with the discovery pass silently corrupts the agent's evidence, which is worse than a slow one, and the call volume is tens per benchmark run. `tests/ws2/helpers.ts` now sends a `GSQL-TIMEOUT` header because RESTPP's default 16s ceiling is uncomfortably close.

**`shortest_path.gsql` and `label_propagation.gsql` deliberately keep the loose rule and the tight `max_hub_degree=25`** — a decided position now, not an oversight:

- **`shortest_path`** answers a different question. Community membership is an *assertion* the agent acts on ("these cards are one actor") and must be conservative; a shortest path is a *lead* an analyst reads and judges. A false positive costs a glance; a false negative hides the only link between a flagged card and a known fraud card. Applying the community bar would return "not found" for nearly every real pair, since most genuine links rest on a single shared entity. Consequence to be aware of: two cards can be 1-2 hops apart here while `get_community` puts them in different communities. That is intended — the two tools make claims of different strength.
- **`label_propagation`** does not need the card-side guard, because the giant-component pathology is specific to **transitive closure**: in WCC, A-B and B-C force A and C together, so chains of weak links merge everything. Majority-vote LPA is not transitive — each card commits to one winning label rather than absorbing its neighbors' components — so it does not chain. Verified on the live graph: 13,234 clusters, largest 144, no degeneracy. Keeping it looser is also the point of having it, as the higher-recall counterpart to the strict WCC.

Both keep `max_hub_degree=25` precisely *because* they have no card-side guard: for them the hub cap is the only guard there is. `gsql/install.ts` therefore passes two different caps by design (`WCC_MAX_HUB_DEGREE=1000` vs `LOOSE_PROJECTION_MAX_HUB_DEGREE=25`), which is intentional rather than an oversight.

**Known property, not a bug: component count is NOT monotone in `as_of`.** Because `min_overlap_pct` measures shared entities as a *fraction* of each card's total footprint, later activity enlarges the denominator and can dissolve a link that qualified earlier. Measured: 15,209 components as of 2016-08-01 vs 15,825 as of 2016-12-31 — *fewer* components earlier, the opposite of what an unnormalized rule gives. This is inherent to a relative evidence bar: a coincidence that looked distinctive early stops looking distinctive once a card turns out to touch hundreds of entities. A first attempt at an `as_of` regression test asserted the naive monotonicity and correctly failed; it was replaced with the invariant that does hold (before any history, every card is its own component).

**What this overrides:** the "Hub-degree cap (`max_hub_degree`, default 25)" and "Require 2+ shared entity types" entries immediately below. The 2-type rule survives as a *necessary but not sufficient* condition; the default cap changes from 25 to 1000 for the community queries only; and that entry's closing sentence — leaving `community_lookup`/`shortest_path` inconsistent as a low-stakes matter — is superseded (`community_lookup` is brought in line because the inconsistency was a bug; `shortest_path` stays loose on reasoned grounds rather than for lack of time). It also overrides the `confirmed_fraud_rate >= 0.5` qualifying rule stated in the "without a matching detector" entry below.

**Follow-up owed outside WS2's boundary:** `docs/MCP_TOOLS.md`'s `get_community` row shows `run_installed_query({query_name:"community_lookup", params:{...}})` and does not enumerate parameters; `community_lookup` now takes a fourth parameter (`min_overlap_pct`) and `discovery_report` a fourth (`min_confirmed_pct`). That file is outside `gsql/`, so it was not edited here.

## 2026-09-19 — WS2 `gsql/` judgment calls (in-progress, not yet fully re-verified)

Several design/interpretation calls made while implementing `gsql/` (WS2), none dictated explicitly by PRD/README, recorded so they aren't re-litigated by accident. All queries were installed and smoke-tested against the live full-dataset graph at the time these were made; a full `make verify-gsql` re-run was interrupted by an infra loss (see `docs/logs.md`) before the last fix could be re-verified.

**No schema extension (confirms the kickoff brief's own pivot).** `ALTER GRAPH ... ADD VERTEX/EDGE` is unsupported on this TigerGraph Community Edition 4.3.0-rc1 build. Communities/components are computed on the fly inside queries (BFS/label-propagation over the existing `CARD_DEVICE`/`CARD_ADDRESS`/`CARD_RECIPIENT_EMAIL` edges) rather than persisted as a new attribute on `Card`. Discovery persists only via the pre-existing `Pattern` (`kind="discovered"`) + `MATCHES_PATTERN` edges — and since `MATCHES_PATTERN` only connects `FraudCase -> Pattern` (not `Card -> Pattern`) per the frozen schema, a discovered community's Pattern is linked to the *FraudCases* connected to its member cards, not to the cards directly. `get_community`/`community_lookup.gsql` therefore can't look up a persisted community id on a card either — it recomputes the same bounded-hop component on every call and synthesizes a deterministic id (`"comm_" + <lexicographically smallest member card id>`), so repeated lookups from any member card agree without a stored label.

**Hub-degree cap on the shared-entity projection (`max_hub_degree`, default 25).** Empirically, naive WCC over `CARD_DEVICE`/`CARD_ADDRESS`/`CARD_RECIPIENT_EMAIL` collapses ~90% of all 16,324 cards into one giant component — a handful of device/address values are shared by hundreds-to-thousands of cards, almost certainly a missing/default sentinel value in the IEEE-CIS-derived source data rather than a real shared identity. Any shared vertex whose distinct-card degree exceeds `max_hub_degree` is excluded from propagation/expansion in `community_components.gsql`, `label_propagation.gsql`, `community_lookup.gsql`, and `shortest_path.gsql`.

**Require 2+ shared entity types to connect two cards, not just 1 (`community_components.gsql`, `discovery_report.gsql`).** The hub-degree cap alone wasn't enough: even at `max_hub_degree` as low as 3, a single-shared-attribute definition ("cards are connected if they share *any one* device, address, or recipient email") still transitively chained a large residual component — 3,959 cards at the cap=25 default, down to 1,280 at cap=3, but never to zero, confirming a classic giant-component chaining effect rather than one real fraud ring. Fixed by requiring two cards to share **at least two distinct entity types** (e.g. both a device *and* an address, not just one or the other) before they're considered connected — a materially stronger evidence bar that breaks long single-attribute chains (a chain would need every consecutive pair to independently clear the 2-type bar, which coincidental/default-value overlaps don't produce). Result: the residual dropped from 3,959 cards to a maximum component of 274 cards, with 16,042 total components (up from 12,334) across the same 16,324 cards — a far more plausible distribution for genuine shared-identity clusters. `community_lookup.gsql` and `shortest_path.gsql` were left on the simpler single-type cap (interactive per-call lookups, lower stakes than the batch WCC health metric and discovery pass) — a documented inconsistency, not revisited further given time constraints.

**`DELETE` + `INSERT INTO` of the same vertex id within one GSQL query silently nets to a deletion on this build.** Found while fixing `discovery_report.gsql` to clear stale discovered `Pattern`s from a prior clustering before writing the current ones: combining the `DELETE` and the `INSERT INTO` of the same id in one query body left the `Pattern` count at 0 instead of 1 (confirmed via an isolated spike query — same result). The engine appears to batch/apply DML writes at the end of a query in an order where a same-id delete wins over an insert issued earlier in the query text. Fixed by splitting into two separate installed queries run as separate invocations in a fixed order — `discovery_clear()` (delete only) then `discovery_report()` (insert only), wired that way in `gsql/install.ts` — which sidesteps the ordering ambiguity entirely since each query's writes fully commit before the next one starts.

**"capped at 3h" (kickoff brief, discovery) read as "top 3 by confirmed-fraud rate."** The brief's phrasing is ambiguous between a 3-hour temporal window and a top-3 count cap. There's no natural 3-hour cutoff for a batch discovery pass over already-closed historical cases, so `discovery_report.gsql` caps its `HeapAccum` at 3 and picks the highest-`n_confirmed` qualifying components.

**"without a matching detector" (kickoff brief, discovery) read as a structural claim, not `case.pattern == "undocumented"`.** Only 4 of 5,565 real closed cases carry that literal label (checked via a spike query) — gating on it made discovery fire on nothing. Reinterpreted as: a dense shared-entity cluster with a high confirmed-fraud concentration that the five per-transaction detectors (which look for specific burst/timing/device signatures) wouldn't surface on their own, regardless of what pattern label its historical cases happen to carry. Qualifying rule: `size >= 2 AND n_cases >= 2 AND confirmed_fraud_rate >= 0.5`.

**`find_prior_cases` matches both the given card and its owning customer.** Closed cases in the real dataset can reference a *stub* card (e.g. `C00259-K1`) distinct from the real card the fraud transaction was actually `MADE` on (e.g. `C15620-K1`, customer `C00259`), while the case's `customer_id` column is the real customer. `find_prior_cases.gsql` therefore matches on `CONNECTED_TO`/`ABOUT` edges to the exact given card id **and** on `ABOUT` edges to the card's resolved owning customer — verified against the documented case: querying on real card `C15620-K1` correctly surfaces closed case `CC-0001`, whose own `card_id` column is the stub.

**Detector thresholds are documented simplifications, not exact burst-window math.** This GSQL dialect has no window functions and no multi-hop patterns, so pairwise sliding-time-window burst detection (e.g. "3 small purchases within exactly one rolling hour") isn't cheaply expressible. Each of the 5 detectors under `detectors/` instead uses a whole-history or fixed-lookback-window count (documented in each file's header) as a conservative proxy — a real burst always satisfies the looser condition; the false-positive risk from a legitimate customer occasionally matching the looser condition is left to the evidence list for a reviewer to rule out.

**`.gsql` files must be plain ASCII.** Any non-ASCII byte (an em-dash, `§`, a smart quote) anywhere in a `.gsql` file — including inside a `//` comment — makes this build's `gsql -f` silently abort the entire file: exit code 0, empty stdout, no query created, no error message. This cost real debugging time to isolate (see `docs/logs.md`) and isn't documented anywhere upstream; every `.gsql` file WS2 writes uses `--` instead of em-dash and `sec.` instead of `§`.

**One `PRINT` statement per query, if the caller expects one result object.** Multiple `PRINT` statements in one query each become a *separate object* in the REST response's `results` array instead of merging into one object (found via `tests/ws2/*.test.ts` — `txn_history.gsql`/`neighborhood.gsql`/`shared_rings.gsql` each originally had 2-3 `PRINT`s and callers reading `results[0]` silently only saw the first one's fields). Fixed by combining into one comma-separated `PRINT a, b, c;`. Multiple `PRINT`s inside mutually-exclusive `IF` branches (as in `get_entity_profile.gsql`) are fine, since only one branch's `PRINT` actually executes per call.

**`"type"` is a reserved word in this GSQL grammar** (same class of issue as `"count"`, documented in `card_velocity.gsql`/`txn_history.gsql`), rejected even as a `TUPLE` field name. `neighborhood.gsql`'s node/edge tuples therefore use `vtype`/`vid`/`etype`/`efrom`/`eto` instead of the contract's `type`/`id`/`from`/`to` spelling — a caller mapping this query's output to the contract shape needs to rename these fields.

## 2026-09-18 — Python allowed, narrowly, for the official TigerGraph MCP server

**Decided:** relax the "no Python" stack rule specifically for installing/running `tigergraph-mcp` (https://github.com/tigergraph/tigergraph-mcp#installation) — the required hackathon component whose official implementation is Python-only. Per explicit user instruction: "i also dont want to fully commit to only ts i just prefferred it so if there is a way to do that easily in python we can use that... if we need the python we can use that." TypeScript-only was always a preference, not an inviolable constraint, and the user chose to relax it here specifically rather than have WS1 route around it.

**What this supersedes:** the earlier resolution in the TigerGraph MCP entry below said to run `tigergraph-mcp` as an external Docker process specifically to avoid any Python entering the repo. That workaround is no longer necessary — WS1 can install and run it directly per its own README (e.g. `pip`/`uv` install) if that's simpler than a Docker wrapper. The external-process option is still fine too; either is acceptable now.

**Scope — this is narrow, not a general stack reversal:** Python is allowed only for this one required third-party component, kept isolated to its own directory (e.g. a subfolder under `graph/`, its own venv/deps, not mixed into `agent/`/`policy/`/other TS application code). It is not a green light for Python anywhere else in the project — CLAUDE.md and PRD.md were both updated to state the exception narrowly, not removed wholesale. `graph/`'s TypeScript code still talks to the MCP server as a client (via `@modelcontextprotocol/sdk`, from `agent/`) regardless of what language the server itself is written in.

**What it overrides:** CLAUDE.md's "Stack" section ("No Python") and PRD.md's stack paragraph ("no Python anywhere") — both updated in place with this one named exception.

## 2026-09-18 — TigerGraph via local Docker Community Edition, not Savanna cloud

**Decided:** run TigerGraph Community Edition locally via `docker-compose.yml` (root, service `tigergraph`, image `tigergraph/tigergraph:latest`, ports 9000/14240/14022) instead of provisioning a Savanna cloud workspace, per explicit user instruction ("setup their docker images and compose... get creds yourself and fill it").

**Why:** Savanna requires a human to sign up for a TigerGraph Cloud account — not something Claude Code can self-serve. Docker CE needs no external account, so credentials/setup can be handled end-to-end in-session.

**Caveat surfaced to the user before proceeding:** TigerGraph's own docs state a minimum of 16GB RAM / 4 CPUs for CE (20GB/8 CPUs recommended). This machine has 15GB total RAM. User chose to proceed anyway (stopped two unrelated containers, `spiderman-postgres`/`spiderman-redis`, to free memory — they can be restarted with `docker start spiderman-postgres spiderman-redis`). If TigerGraph is unstable under this load, the fallback is Savanna, which needs the user to hand over real workspace credentials.

**What it overrides:** PRD §18.1 listed Savanna as the primary option (OQ5 called both "either works"); Docker CE is now the one actually running for this project.

**Resolution / how it actually ended up running:** the public `tigergraph/community:latest` tag isn't pullable directly — the real path is signing up at dl.tigergraph.com for a CE download link (user did this, forwarded the emailed link), `curl`-downloading the ~2.6GB `tigergraph-4.3.0-rc1-community-docker-image.tar.gz`, `docker load`-ing it (produces local tag `tigergraph/community:4.3.0-rc1`), then `docker compose up -d`. An earlier attempt with `tigergraph/tigergraph:latest` (the licensed Enterprise image) got stuck in permanent `Warmup` for GPE/GSE/RESTPP because of `License expired: Thu Jan 1 00:00:00 1970` — that image needs a real license key we don't have, hence the switch to Community Edition. Confirmed working: REST API (`curl http://localhost:9000/echo` → `{"error":false,"message":"Hello GSQL"}`) and GSQL shell (`gsql -u tigergraph -p tigergraph`) both respond with the CE image's default credentials `tigergraph`/`tigergraph` (Linux user and DB superuser both use this password out of the box — TigerGraph's own docs flag this as needing to change before any non-local exposure; left as-is for now since this only binds to localhost). `docker-compose.yml` volume mounts the whole `/home/tigergraph` home dir (matching TigerGraph's own docs) so the loaded schema/data survives container restarts. GPE/GSE report `Warmup` (not `Online`) at idle — this is expected with no graph schema created yet (`Can not refresh graph schema successfully, rc: Empty Content` in their logs is benign, not a crash), and should resolve once WS1 creates the `hhgoa_fraud` graph.

## 2026-09-18 — LLM: local Ollama instead of Claude/`@anthropic-ai/sdk`

**Decided:** swap the agent's reasoning/tool-selection/explanation LLM from Claude (`@anthropic-ai/sdk`, as PRD §5/OQ7 originally specified) to a local Ollama model, run via Docker, using `LLM_BACKEND=ollama` in `.env`. Groq was considered (also free) but not chosen as the default.

**Why:** explicit user instruction — no `ANTHROPIC_API_KEY` available, and "skip anthropic and other stuff." Between the two free alternatives offered (Ollama, Groq), Ollama was picked as the default because it needs zero external account or API key — fully self-serviceable via `docker compose up`. Groq's free tier still requires a human to sign up for an API key, so it's left wired as an optional fallback (`LLM_BACKEND=groq`, `GROQ_API_KEY` in `.env.example`) rather than the default.

**What it overrides:** PRD §5 (Stack paragraph) and OQ7 (§0 table) both said "Claude via `@anthropic-ai/sdk`" — both updated in place. `contracts/` is unaffected (no LLM-specific types live there), so this does not touch the frozen `m0` contracts.

**Resolved (supersedes this item as originally logged):** TigerGraph MCP (`https://github.com/tigergraph/tigergraph-mcp`) is a **required component** of the hackathon brief, not optional — confirmed directly from `docs/CHALLENGE_BRIEF.md` (the original brief, formerly `TigerGraph Agentic Fraud Investigation HHGOA.md` at repo root — read in full to cross-check PRD.md against it), section "What Participants Build With" → "Required components", item 3: "TigerGraph MCP — Use TigerGraph MCP to expose graph capabilities and data to the agent." (GSQL/algorithms, GraphRAG, and the UI are also required components per the same list — all three already match what WS1/WS2/WS3/WS6 were briefed with, no further corrections needed there. The dataset's "before any additional evidence is requested / after any additional evidence is received" next-best-action recording requirement, from the brief's "Submissions" section, is also already captured — `contracts/src/answerFile.ts` and WS7's planned `validateAnswers.ts` check "initial/final next_best_actions" per PRD §16.) Bypassing it with a plain TS REST client (WS1's initial default, given before this was known) does not satisfy the brief. The official server is Python 3.10-3.12 (`pyTigerGraph`-based), which still conflicts with CLAUDE.md's "no Python" rule if committed into this repo — resolved by scope, not by exception: CLAUDE.md's "no Python" governs code *written and committed in this repository*, not third-party services the repo calls. The same precedent already applies to TigerGraph itself (runs as a Docker container, not TS we wrote) and to the `gsql` CLI (a foreign binary invoked via `docker exec`/subprocess). `tigergraph-mcp` follows the same pattern: run it as an **external process** (its own Docker container or subprocess, no `.py` files added to this repo), and `agent/`'s TypeScript code connects to it as a genuine MCP *client* using `@modelcontextprotocol/sdk`'s client APIs over whatever transport the server exposes (stdio or HTTP/SSE). WS1 was redirected from its original REST-bypass default to this approach mid-run (see `docs/logs.md`).

## 2026-09-18 — Monorepo tooling: pnpm workspaces + Turborepo, not npm workspaces

**Decided:** switch from npm workspaces (as originally written in PRD §5/§6/§19 and CLAUDE.md) to pnpm workspaces (`pnpm-workspace.yaml`) orchestrated by Turborepo (`turbo.json`).

**Why:** explicit user instruction mid-session, after WS0 root skeleton had already been drafted once with npm workspaces. User confirmed "pnpm workspaces + Turborepo" over "pnpm only" or "keep npm" when asked.

**What it overrides:** PRD.md §5, §6, §19.1, §19.3 (WS0 kickoff prompt) and CLAUDE.md's "Stack" section previously said "npm workspaces" explicitly — all updated in place to say "pnpm workspaces + Turborepo" so the docs and the actual repo don't diverge. Root `package.json` no longer has a `workspaces` field; package list lives in `pnpm-workspace.yaml`. Task orchestration (`test`, `lint`, etc.) goes through `turbo run <task>` instead of `npm run <task> --workspaces`.

## 2026-09-18 — OpenCode delegation paused; Claude Code implements directly

**Decided:** CLAUDE.md's "Agent Roles" section (added by the user directly, checked into the repo) originally specified Claude as architect/planner and OpenCode as the implementation/execution agent for all substantial code changes. After repeated OpenCode MCP failures this session (model-auth errors across every OpenAI-provider model tried, then the OpenCode MCP server itself disconnecting and its local `opencode serve` process becoming unreachable), the user instructed: change CLAUDE.md to not use OpenCode for now, Claude Code implements directly, reintroduce OpenCode later.

**Why:** OpenCode was unreliable in this environment at the time (auth + connectivity issues, not a fundamental rejection of the delegation model itself).

**What it overrides:** CLAUDE.md's "Agent Roles" and "Implementation Workflow" sections were rewritten to say Claude Code does reasoning, planning, editing, running commands, and verification directly, with OpenCode delegation explicitly marked as "planned but not active" rather than removed as a concept.

## 2026-09-18 — Fixture/example ID conventions

**Decided:** synthetic IDs in `contracts/examples/*.json` and `fixtures/*.json` use formats that match the real dataset's structure (confirmed by inspecting `data/*.csv` headers directly — plain numeric `TransactionID`, `C#####` customer ids, `C#####-K#` card ids, `CC-####` closed-case ids) but fall in numeric ranges clearly outside anything seen in the real files (e.g. transaction ids `"991xxxx"`/`"992xxxx"`, customers `"C0910x"`, closed cases `"CC-09xx"`), so nobody mistakes a fixture for a real dataset row or accidentally treats a fixture ID as resolvable against the real graph once it's loaded.

**Why:** initial draft used a `"T0900001"`-style prefix that doesn't match any real column (`TransactionID` is plain numeric) — caught by checking `data/transactions.csv`'s actual header/rows before finalizing WS0's examples.

## 2026-09-18 — `answerFile.ts`: SAR narrative required when `sar.file` is true

**Decided (observed, not authored by the main thread — a parallel background fork made this edit while working on `tests/ws0/`; reviewed and kept):** added a `superRefine` check that `sar.file === true` requires a non-empty `sar.narrative`.

**Why it's correct:** README's Answer Format table says `narrative` is "Required when `file` is true" — the original schema only encoded the inverse (`file === false` implies blank fields) and missed this direction. Keeping the fork's fix rather than reverting it.

## 2026-09-19 — WS4 real-tools switch: MCP response shape, case-ledger scope, ring-size guard

**Context:** with WS2 (`gsql/`) merged into `main`, the user asked to wire up `TOOLS_BACKEND=real` — `agent/src/agentFactory.ts` had been throwing since WS4's original build, citing "WS1/WS3 services not up yet." Both halves of that excuse were stale (WS1's MCP server + WS2's installed queries exist; WS3's `@hhgoa/rag` runtime is fully built), so this was scoped as: make the real backend genuinely work end-to-end, verify it against the live graph (not just typecheck), fix what breaks.

**Decided — MCP response parsing was wrong and would have crashed on every real call.** `RealMcpClient.callTool` previously called MCP tools by contract name (`client.callTool({name: "resolve_trigger", ...})`) and, on the response, either read `structuredContent` or `JSON.parse()`'d the first text block directly. Neither holds against the live `tigergraph-mcp` server (verified live, not assumed): the only real MCP tool is `tigergraph__run_installed_query` (`{query_name, params, graph_name}`); there is no `structuredContent`; and `content[0].text` is a **markdown-wrapped** JSON block (```` ```json\n{...}\n``` ````) followed by a human-readable duplicate, so a bare `JSON.parse` throws immediately. The parsed envelope is `{success, data:{result:[...]}, error?}`, `result` always a one-element array (every WS2 query issues exactly one `PRINT`). Critically, **the MCP-protocol-level `isError` field stays `false` even when the query itself fails** (verified with a bad query name: `isError: false`, but the parsed payload has `success: false` + an `error` string) — the failure signal is nested inside the payload, not exposed by the SDK's own error path. Rewrote `callTool` to route every one of the 10 graph tools through `run_installed_query` at WS2's actual installed query names, with a per-tool transform from each query's raw PRINT shape (entity-type case mapping `Card`↔`card`, map→array conversions for `shared_rings`/`detect_patterns`, field renames for `neighborhood`/`card_velocity`/`txn_history`/`get_community`, the vertex-array unwrap for `get_entity_profile`'s identity/device/address branches).

**Decided — case bookkeeping stays in-memory, not a graph write.** `case_open`'s contract shape includes a `graph_case_id`, which could be read as "open a real case vertex in TigerGraph." Didn't do that: writing live investigation cases into the graph is a schema/architecture decision of its own (`contracts/` is frozen post-M0; WS2 already found `ALTER GRAPH` unsupported on this TigerGraph build and had to redesign around that once already — see the 2026-09-19 WS2 entries above), not something to make unilaterally inside an integration pass whose actual goal was "make the graph *reads* real." Added `agent/src/caseLedger.ts`, a plain in-memory, per-run case ledger; `graph_case_id` is a synthetic id, not a real graph vertex reference. Caught live that `ToolRegistry`'s silent case accessors (`caseUpdateAssessment` etc., `toolsRegistry.ts`) always key off `RunAgentOptions.caseId` — the id the *caller* assigned — never whatever `case_open` returns; the ledger's first version minted its own id and every call after `case_open` threw "unknown case_id" the first time it was actually run. Fixed by constructing the ledger with the known case id up front rather than generating one.

**Decided — `get_wide_features` and the providers never actually reachable through `ToolCatalog.providers` (the 10 graph tools, `policy_check`/`execute_action`/`generate_sar`/`request_evidence`) fail loudly under `TOOLS_BACKEND=real` rather than fall back to fake data.** `get_wide_features` (local DuckDB) has no real implementation yet — returning the fake canned rows under a "real" backend would silently lie about where the data came from; throwing a clear "not implemented, see docs/REQUESTS.md" is the honest choice. The other members are dead code paths by the existing `ToolRegistry` design (graph tools route through MCP, the policy trio routes through `policies`, not `providers`) — required only to satisfy the `ToolCatalog` type; a throw catches a real wiring bug if one is ever actually invoked instead of silently returning wrong data.

**Decided — `find_shared_entity_rings` needed a caller-side ring-size guard, found live, not by inspection.** Running a real trigger (HHG-001's txn `3514030`) through the full pipeline came back with a "shared device ring" of several hundred cards — the same missing/default sentinel device value (`74ac7f403a804e8e`) that `gsql/algorithms/community_components.gsql` already excludes from community detection (one of the 20 dataset-wide vertices with degree > 1000). `shared_rings.gsql` applies no hub cap by design (its own header comment: hands back the raw per-entity card set for the caller to judge) — so the guard belongs at the transform layer, not the query. Added `MAX_PLAUSIBLE_RING_SIZE = 50` in `agent/src/mcpClient.ts` (generous relative to the actual discovered-pattern sizes of 9/5/5 cards from WS2's community work, while excluding hundred-plus-card sentinel noise); rings above it are dropped rather than handed to the agent as evidence. A second, smaller ring (45 cards, a different device) passed through unfiltered on the same run — left as-is rather than tuned further without more evidence that it's actually noise rather than a real if unusually broad shared device.

**Infra fix alongside this:** `graph/mcp-server/venv` (the tigergraph-mcp Python install) only existed in a disposable leftover worktree with a broken `pip` symlink, and — more importantly — had no `.gitignore` entry at all (a 79MB venv one `git add -A` away from being committed). Rebuilt cleanly in the main tree, added `graph/mcp-server/venv/` to `.gitignore`, and added a committed `graph/mcp-server/.env.example` (non-secret CE demo defaults) since `.env` itself stays gitignored per the existing blanket rule.

**Verification:** `make test` green across all 9 workspace packages (367 tests, unchanged pass count from before this work — nothing regressed), `pnpm --filter @hhgoa/agent typecheck` / `@hhgoa/rag typecheck` / `@hhgoa/policy typecheck` all clean, and a full real run against the live graph + real dataset (HHG-001's trigger) produced a coherent `escalated`/`card_testing`/`fraud_probability: 0.89` result with real resolved entities, real transaction/ring/prior-case evidence, and a real RAG-backed `request_evidence` round — not canned fixture data.

## 2026-09-21 — evidence-layer ring-size gate (the 2026-09-19 `MAX_PLAUSIBLE_RING_SIZE` decision above didn't fully close this)

**Context:** user flagged that all 20 exported benchmark cases (`cases/HHG-*.json`) show `verdict: fraud`, with only two distinct `fraud_probability` values repeating across unrelated cards — implausible given the README's "half the cases are legitimate." Traced to `cases/HHG-001.json`'s own exported evidence still citing the 45-card device-profile ring as `card_testing`-supporting.

**Decided — the evidence-generation path needed its own plausibility gate, separate from the transport-layer one.** Two caps already existed for shared-entity rings, at different layers and for different purposes: `mcpClient.ts`'s `MAX_PLAUSIBLE_RING_SIZE = 50` (drops sentinel/missing-value rings of 100+ cards before they reach the agent at all — the 2026-09-19 decision above) and `sharedOrigin.ts`'s `MAX_CORROBORATING_RING_SIZE = 10` (gates the *policy* decision, `shared_origin_connection`, requiring both a plausible ring size and independent corroboration). Neither reached `agent/src/evidenceBuilder.ts`'s `ringsEvidence()`, which built a `device_identity`/`supports: ["card_testing"]`/weight-0.65 item from *any* ring the transport layer let through — so an 11-to-50-card ring (past the sentinel filter, but well past the 10-card corroboration bar) still read as strong fraud evidence to the assessor and the LLM, even though the policy layer had already correctly decided it doesn't count as a `shared_origin_connection`.

**Why this is a distinct decision from the 2026-09-19 one, not a reversal of it:** that entry decided a 45-card ring should not be dropped outright at the transport layer ("left as-is rather than tuned further without more evidence that it's actually noise"). This doesn't drop it — the fact is still reported. It stops the evidence builder from independently re-asserting "this supports card_testing" for a ring the policy layer already treats as uncorroborated noise, which is the inconsistency that was actually causing the skew.

**Fix:** `ringsEvidence()` now imports `MAX_CORROBORATING_RING_SIZE` from `sharedOrigin.ts`. Rings ≤10 cards: unchanged (`supports: ["card_testing"]`, weight 0.65). Rings >10 cards: `supports: []`, weight 0.15, summary states the group is too large to be a specific fraud ring. Chose to reuse `sharedOrigin.ts`'s existing constant rather than introduce a third threshold, so the evidence layer and the policy layer agree on what "plausible" means by construction, not by two numbers happening to match.

**Verification:** `pnpm --filter @hhgoa/agent typecheck` clean; `tests/ws4/*` 89/89 pass unchanged (the only existing ring-evidence test fixture uses a 2-card ring, below the new branch point). Regenerating the actual 20 case files to confirm the verdict mix improves needs a live TigerGraph, not available at decision time in this sandbox — queued as the next step.

## 2026-09-21 — the real root cause of "all 20 = fraud": the assessor's structured-output schema was never shown to the local model

**Context:** brought up `docker compose` (TigerGraph CE + mcp-server) and reran the full pipeline (`make verify-graph`, `make verify-gsql`, `pnpm --filter @hhgoa/eval run-benchmark -- --no-cache`) to check whether the ring-evidence fix above actually moved the verdict mix. It didn't: still 20/20 `fraud`, still only 2-3 distinct `fraud_probability` values repeating across unrelated cases.

**Found, by direct arithmetic then confirmed by direct probe:** `cases/HHG-002.json`'s hypotheses (`0.846154`/`0.153846`) matched `agent/src/assess.ts`'s `fallbackAssessmentProposal()` formula exactly (`min(0.55, max(0.3, risk_score=0.79)) = 0.55`, normalized over `[0.55, 0.1]`). The real LLM's `structuredCall` (`agent/src/structured.ts`) was silently hitting its fallback on essentially every case — both the first attempt and the one repair retry were failing schema validation, with no thrown error (the fallback path is designed to be silent, PRD §13's "every run completes" guarantee), so the benchmark completed cleanly while quietly running on a deterministic formula the whole time. That formula, by construction, can **never** produce a `legitimate` verdict: the top fraud hypothesis is floored at 0.3 and the `legitimate` hypothesis is a fixed small residual — `evidenceTopPattern` only returns `null` (which would fall back to `"undocumented"`, still non-legitimate) when there's zero supporting evidence at all, which essentially never happens once any evidence has been gathered.

**Root cause, confirmed by directly calling `OpenAiCompatLlmClient` with the real assessor prompt:** the model (`Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M` via local llama.cpp) returned syntactically valid JSON, but **flattened** — `{"fraud_type": [...], "probability": ..., ...}` at the top level — instead of the required `{"hypotheses": [{fraud_type, probability, ...}, ...], risk_level, ...}` shape. `agent/src/prompts.ts`'s `assessSystemPrompt()` described every field in prose but never showed the model the actual JSON structure, so a smaller/quantized local model (unlike a top-tier hosted one) had to guess the nesting and consistently guessed wrong.

**Decided — fix the prompt, not the fallback.** Tightening the fallback formula to sometimes emit `legitimate` would have hidden the real defect (the LLM's structured output was never actually being used) behind a differently-biased guess. Instead, added an explicit example JSON object (concrete `hypotheses` array with two example entries) to `assessSystemPrompt()`. Re-probed directly: the model immediately returned schema-valid output with genuinely mixed probabilities.

**Verification:** `pnpm --filter @hhgoa/agent typecheck` clean; `tests/ws4/*` 89/89 pass unchanged (they use `MockLlmClient`, not the real prompt text). Regenerated all 20 cases twice against the live graph: verdict mix went from 20/20 `fraud` → a genuine mix (12 fraud/3 legitimate/5 uncertain on the first rerun, 14/1/5 on the final clean rerun below) with per-case probabilities that actually vary. `make validate-answers`: PASS, 20/20.

**Separate, real finding surfaced along the way (not fixed, documented as an operational constraint):** the two consecutive `--no-cache` reruns above (done to test this fix) caused `HHG-008`'s own answer to cite its *own* synthetic `graph_case_id` (`GRAPH-HHG-008`, written to the live TigerGraph by the first rerun via `agent/src/persistCase.ts`'s `upsert_case_record` call) as a `similar_prior_cases` entry in the second rerun — a case citing itself as precedent. Root cause: `persistCaseToGraph` writes a real `FraudCase` vertex with `p_opened_at`/`p_closed_at` set to the investigation's own `as_of`, so on a second run of the identical case, `find_prior_cases`'s `visible_from <= as_of` filter is satisfied by the case's own prior write (equal timestamps, not strictly future) rather than excluded by it. This is **not a fresh-graph problem** — running the benchmark once against a freshly loaded graph (`make verify-graph` + `make verify-gsql` before `run-benchmark`) cannot self-reference, since no prior write of that case_id exists yet. Confirmed: `make validate-answers` passed clean, 20/20, no self-reference errors, once the graph was reset and the benchmark run exactly once. **Operational rule going forward: always reset the graph (`make verify-graph` + `make verify-gsql`) before a `run-benchmark` pass intended to produce the graded answer set; don't rerun `run-benchmark` twice against the same live graph state.** A real code fix (excluding the querying case's own id from `find_prior_cases`/bumping `closed_at` past `as_of`) would be needed before the write-back path is safe for a live demo's repeated/re-triggered investigations — left as a follow-up, not done here.

**Also found in this pass (infra, not code):** TigerGraph Community Edition's `discovery_report` and (once, on `HHG-004`) `upsert_case_record` intermittently abort with "System Memory in Critical state. Memory saving mode is only available for Enterprise Edition" under this host's ~15GB RAM budget when heavy whole-graph queries and write-backs run back-to-back. Handled gracefully by existing code (`persistCase.ts` catches the failure and reports `written_to_graph: false` honestly rather than crashing) — not a defect, just a resource ceiling of the free CE image worth knowing about if a live demo repeats heavy operations in quick succession.

**Also fixed alongside this (config, not logic):** `gsql/vitest.config.ts`'s `testTimeout` was 30s; two tests (`community_lookup > synthesizes the community id...`, `discovery_report > discovered community ids and sizes agree with community_lookup`) make 2-3 sequential ~15-20s whole-graph query calls each, so their total runtime legitimately exceeds 30s even though every individual query call succeeds. Bumped to 90s, matching the precedent already set in `eval/vitest.config.ts` for the same class of "real dataset is just slow" test. Verified: both tests pass in isolation and as part of the full `make test` run (9/9 packages green).

## 2026-09-22 — rejected: deriving `fraud_probability` from evidence weights instead of asking the model

**Context:** seven measured iterations established that the local model does not calibrate — it selects `fraud_probability` from whatever numbers appear in its prompt (14 of 20 cases took their value verbatim from prompt text; removing every numeral just moved it to round values on a 0.05 grid). `fraud_probability` is explicitly scored for calibration per the README, so this is a real weakness, and the obvious remedy is to stop asking the model for the number and compute it from the `weight_hint` values the evidence pipeline already carries.

**Built it, then reverted it.** The implementation forced three successive judgment calls, each individually defensible and collectively damning:
1. Naive summing of supporting weights let HHG-011's 240 ring items swamp an explicit cardholder confirmation — the exact "many weak items = conviction" fallacy the assessor prompt warns the *model* against. Switched to one item per independent evidence category.
2. Any hypothesis the evidence was silent on then scored exactly 0, handing the leader **precisely 1.00**. Added a smoothing prior.
3. Three existing tests failed, and reading them showed the failure *was* the point: `"verdict follows the probability bands"` asserts that when the assessor says 0.2, the case reads legitimate. The change let evidence weights override the model's stated judgment and flip it to fraud.

**Decided to keep the model's number.** The end state was a hand-tuned scoring function — arbitrary weights, an arbitrary category rule, an arbitrary prior — replacing one unvalidatable number with another, while breaking documented behaviour. There is no answer key for the 20 cases (README: "We score them against an answer key you don't have"), so I could not demonstrate the replacement was *better*, only different. Shipping it would have been motion disguised as progress.

**What would earn this change:** `eval/backtest.ts` against `closed_cases_history.csv`'s known `confirmed_fraud`/`cleared` outcomes is the only ground truth available to this project, and it has still never been run. A scoring function tuned and validated against that backtest would be defensible; one tuned against a distribution I merely *feel* is wrong is not. Recorded as the next real step for calibration work.

## 2026-09-22 — `shared_rings` gained `min_ring_size` and `window_days`; the seed card is always in its own ring

**Context:** HHG-011's answer file came back at 3.3MB with 1486 evidence items, of which **420 were "rings" containing no card other than the seed** — i.e. devices nobody else had ever used, reported as *"shares device profile X with 1 other cards"* (itself an off-by-one, since `card_ids` includes the seed). The query had no minimum group size and no recency bound, so it returned every device/address/email the card had ever touched rather than, as the README puts it, entities "shared across many cards **in a short window**".

**Decided to filter in GSQL, not in the client.** The recency bound can only be applied where `first_ts` is available, and shipping 1355 groups over the wire to discard 375 of them client-side is waste. `min_ring_size = 2` (the seed plus at least one other card — a group of one is not a ring) and `window_days = 30`, with `0` disabling the window, matching `txn_history.gsql`'s existing convention for `window_hours`. The 30-day default follows the README's own worked example, where a device profile "appears on a closed case from August and on another card this month". Measured on HHG-011's card: 1355 groups → 250, all 375 seed-only groups gone.

**Note this is filtering, not evidence-cutting.** An earlier attempt in the same session to cap ring *evidence items* for prompt space was correctly rejected by the user — ring breadth is signal the README explicitly calls out, and it is scored content in the answer file. The distinction: dropping a group that contains only the seed card removes a degenerate non-result; truncating genuine multi-card rings to fit a context window destroys information. The context window was enlarged instead.

**Bug in the first version, caught by `tests/ws2/txnAndNeighborhood.test.ts`:** the recency filter was applied on the traversal *back* from the shared entity to all cards, which includes the seed card's own edge — so any card that had used a device for longer than `window_days` was silently filtered out of its own ring. Each group is now seeded with the seed card explicitly, bounded by `as_of` only, and the window governs solely which *other* cards join it. That is also the better reading of the hint: a ring is interesting because other cards **converged recently**, not because the seed did.

## Simulated cardholder replies are evidence, not an oracle (2026-09-22)

**Context.** `docs/DATASET_README.md` §5 (lines 159, 271) states that cardholder
and analyst replies "are not provided" and instructs each team to *simulate* the
response and record the assumption in `evidence_requests`. Our simulator
(`policy/src/evidence.ts`) picks between two documented outcomes with
`sha256(type, target.type, target.id, reason) & 1` — deliberately not a function
of any hidden fraud label (there is none in the dataset, PRD OQ11). That part is
correct and stays.

**Problem.** The fabricated reply was then treated as ground truth in two places
at once:

1. `agent/src/prompts.ts` told the assessor to calibrate to `0.15-0.4` when "the
   activity fits the cardholder's history, **or they confirmed it**", and
2. `agent/src/machine.ts:computeVerdict` applied the same reply *again* as an
   absolute veto (`confirmed` → `legitimate` unless `topProb >= 0.85`).

So a coin flip was counted twice, the second time as an override. Measured on a
35-case backtest (29 confirmed fraud): every confirmed-fraud case that drew a
scripted "customer confirms" closed `legitimate` — 6 of 6 — accounting for 6 of
the 8 false negatives. One of them (CC-4225) had 159 evidence items and another
(CC-5475) 105; all of it was discarded by the flip. Five false negatives filed a
probability of *exactly* 0.400, the top of the band the prompt names, which is
the fingerprint of the first half of the double-count. The control group settles
it: of the 21 fraud cases where no reply was drawn, 19 were caught (90% recall)
against 0 of 4 where a confirmation was.

**Decision.** The reply stays simulated and documented, but is weighed as one
ordinary signal rather than as proof:

- the `or they confirmed it` clause is gone from the calibration band, and the
  prompt now states plainly that a reply is a simulated assumption which on its
  own must not overturn graph evidence;
- `computeVerdict` decides on the probability bands. A *denial* can still
  promote the uncertain band to `fraud` and downgrades a near-exculpatory
  clearance to `uncertain`, but a confirmation no longer vetoes anything.

**Why this is not gaming the benchmark.** We are not reading the label — the
simulator still cannot see it. We are declining to let a figure our own system
invented outrank evidence read from the graph. README's own worked example
(line 420) treats a reply as a probability *update* — "Customer denial raised
probability from 0.72 to 0.86" — not as an override, so this is closer to the
spec than the veto was. Policy rules R2/R3 continue to key off
`customer_denied` / `customer_confirmed` for *actions*, which is where the
README puts them.

**Known limitation.** Because the reply is uncorrelated with truth by
construction, it can only add noise. Weighing it at all costs some accuracy;
weighing it as an oracle cost 6 of 8 false negatives. If the graders supply real
replies, `DatasetResponder` is the seam to fill in.

## Lookback window widened to 168h (2026-09-22)

Cases are opened *after* the fraud episode has run, not during it. Across the
4665 confirmed-fraud closed cases the oldest fraud transaction is a median 22h
old at `opened_at`, but p95 is 109h. A 72h sweep fully covers 89.8% of cases;
168h covers 97.8%. No case has zero fraud transactions inside 72h, so this is a
recall fix for `affected_txn_ids`, not a verdict fix. CC-1275 was the case that
exposed it: 13 fraud transactions spanning 07-18 to 07-26 with `as_of` at 07-27,
of which a 72h window saw 4.

## Multi-stage prompting before Kev; main-LLM context lowered to share the GPU (2026-09-22)

**Decision.** Build the multi-stage prompt flow first and iterate on it. Add Kev
only if the staged flow still under-performs. When Kev is added, lower the main
LLM's context window so both models fit in GPU memory at once.

**Why staged prompting first.** `agent/src/prompts.ts` defines seven prompt
builders and only one is reachable:

| builder | call sites |
| --- | --- |
| `assessSystemPrompt` | 1 (`machine.ts:236`) |
| `systemPrompt` | 0 |
| `investigatorPrompt` | 0 |
| `triageSystemPrompt` | 0 |
| `calibrateSystemPrompt` | 0 |
| `evidencePlannerSystemPrompt` | 0 |
| `explainerSystemPrompt` | 0 |

`TRIAGE_JSON_SCHEMA` (`assess.ts:122`) is likewise defined and never used. The
whole agent is therefore a single assessor call, and the staged flow the code was
clearly designed for — triage, investigate, plan evidence, assess, explain — was
never wired up. Two judging criteria reward exactly what is missing: *Agentic
design and engineering* (15%) covers workflow orchestration and tool use, and
*Innovation* (15%) covers agentic capability. Wiring the existing builders is
cheaper than adding a new runtime dependency, so it goes first.

A trap this dead code already set: an earlier fix in this session edited
`calibrateSystemPrompt` to realign its numeric probability bands with
`FRAUD_VERDICT_THRESHOLD` (0.7) and to delete "or they confirmed it" from the low
band. That function is never called, so the edit changed nothing, and the live
`assessSystemPrompt` still carries the prose form of the same "or they confirmed
it" clause. It is currently inert only because `SimulatedResponder` no longer
fabricates a confirmation. **Before editing a prompt, confirm it has a call
site.**

**Why Kev is a real option and not a detour.** `github.com/jaredpalmer/kev` is a
family of fine-tunable decision models ("a tiny Jev-like family of decision
models built on top of Qwen3.5"), sized 0.8B/4B/9B, rank-16 LoRA plus a small
pointer head, Python with a REST server. It answers `choice`, `noul` (binary) and
`score` questions and returns a probability distribution over the options. The
hackathon organiser (Devanshu, TigerGraph DevRel, Discord) confirmed such models
are allowed: "Great for routing and scoring inside your agent, but you will still
need an LLM for the actual answers." So Kev may classify and score; the LLM must
still produce case summaries, SAR narratives and explanations.

It targets a measured weakness. The 20-case leak-free backtest of 2026-09-22
produced this `fraud_probability` distribution:

```
0.65 x7   0.75 x3   0.55 x2   0.60 x2   0.619048 x2
0.45 x1   0.47619 x1   0.590909 x1   0.46875 x1
```

`0.65` appears seven times, one notch below the 0.70 fraud threshold, so 17 of 20
verdicts land on `uncertain`. There is no clamp doing this —
`machine.ts:reconciledProbability` only adjusts on a cardholder denial or
confirmation, neither of which now occurs — it is a 7B general model anchoring on
round numbers instead of calibrating. A decision model returning a distribution
over {five patterns + legitimate} addresses that directly, where more prompt text
has already failed to.

**Why the main LLM's context must shrink.** The host has 15 GiB total. TigerGraph
holds ~2.4 GiB steady (and needs far more transiently: `community_components` and
`discovery_report` failed twice with "System Memory in Critical state" until
llama-server was stopped). llama-server at `-c 16384` holds ~5.5 GiB. Kev must
fit alongside, so the plan is to lower `-c` for the main LLM rather than swap
models in and out per call, and to prefer Kev 0.8B over 4B/9B. The assessor brief
is the binding constraint on how far `-c` can drop: `.env` notes at least
`-c 16384` for a ~13k-token brief, so shrinking context requires shrinking the
brief (staged prompting helps here, since each stage sees less than one
monolithic brief).

**Status when recorded.** Leak-free 20-case backtest: pattern exact 8/17 = 47.1%
(8/14 = 57.1% excluding the three `undocumented` cases, which are unpredictable
by design); false negatives 0/17, down from 27.6%; false positives 3/3 cleared
cases escalated, which is the open problem and worse than the 50% before. Recall
is solved; discrimination is not.

## Assessor stage count: single-stage is the default, two-stage is a measured switch

**Decision.** `ASSESSOR_STAGES` defaults to `1` (one structured call that
classifies and calibrates together). `2` (triage with no numbers, then
calibration over the survivors) stays implemented and selectable, but is not
the default.

**Evidence.** Same leak-free 20-case sample, same evidence encodings, same
model (Qwen2.5-7B Q4_K_M):

| | single-stage (iter 1) | two-stage (iter 1b) |
|---|---|---|
| pattern exact (confirmed fraud) | 8/17 = 47.1% | 3/17 = 17.6% |
| false negatives | 0/17 | 6/17 |
| decision agreement | 85% | 60% |
| cleared escalated | 3/3 | 2/3 |
| latency / case | ~24s | ~31s |

Two-stage was introduced to break the single-call hedge (7 of 20
probabilities on exactly 0.65). It did break it, at the cost of the judgement
itself.

**Why two-stage failed, mechanically.** Two failure paths, both structural:

1. Triage could delete every fraud hypothesis. `renderTriageForCalibration`
   kept only `fits=true` candidates; on a thin brief the 7B marks all fraud
   patterns `fits=false` and `legitimate` `fits=true` (the exculpatory items
   give it something to cite). Calibration then never saw a fraud
   alternative, `finalizeAssessment` read `topFraud?.probability ?? 0`, and
   the case filed `legitimate`/`none` at probability exactly 0. CC-2247 and
   CC-2673 did this with 325 and 313 evidence items and recommended
   `ALLOW_TRANSACTION` + `CLOSE_NO_FRAUD` on confirmed card_testing. Fixed by
   always handing calibration the best-supported fraud candidate (flagged
   as un-endorsed); kept, because it is correct for `stages=2` and inert for
   `stages=1`.
2. Classification got worse when split. Judging each pattern "on its own
   merits" (the triage instruction) removed the comparison a single pass
   makes implicitly; `account_takeover` became the magnet (4 predictions, 1
   right) and `out_of_region_use` was read as takeover twice. This is not a
   prompt-wording problem — it is that a 7B model makes a comparative
   judgement worse in pieces than in one pass.

**What was kept from the two-stage iteration.** Everything independent of the
split: honest exculpatory encodings (why cleared escalation fell 3/3 → 2/3),
email rings demoted to descriptive (README line 75: domains, not identity),
MCP/LLM call timeouts, and the triage guard above.

**Consequence to accept.** The 0.65 hedge that two-stage was meant to fix is
back. It is the lesser problem: it costs discrimination on cleared cases (the
"escalate everything" behaviour), not false negatives on confirmed fraud.
The next lever for the hedge should be on the evidence/encoding side or a
dedicated scoring model (Kev, per the plan), not another split of the
assessor call.

**Not chosen.** Lowering the 0.4 `legitimate` threshold to recover the
two-stage false negatives — that trades them back for false positives, and
moves the line instead of fixing the evidence.

## Detector thresholds come from the measured gold shape, not the policy text's literal numbers

**Context.** `docs/DATASET_README.md` describes card testing as "three or more tiny
online authorizations, often under $5, then a larger purchase" and policy R5 says
"within an hour". Implementing R5 literally (`< $5`, span `<= 1h`, then `> $100`)
made `detect_patterns` fire on **0 of 16** gold `card_testing` cases: measured over
the 48h before `opened_at`, "under $5" holds for 2/16, "under $10" for 10/16, and
no case has its small authorizations inside one hour — they spread across the two
days. Two of the four follow-on purchases are between $50 and $100. Likewise the
account-takeover gate required mixed online+in-person activity and a match-flag
failure spike against the card's own prior baseline; measured on 120 gold cases,
the spike fires on 4 (90 open with no prior window to baseline against) and mixed
channel is 51% on gold vs 48% on cleared — no signal.

**Decision.** Detector bars are set to the measured shape of the labelled cases and
the deviation from the rule text is stated in the query comments and
`docs/TX_FLAGGING_CRITERIA.md`:
- `card_testing`: `>= 3` online `< $10` in the 48h episode -> 0.55; a `> $50` online
  purchase after the last of them -> 0.9. The sequence ("followed by") is kept; the
  one-hour span is not applied.
- `account_takeover`: match-flag failure rate `>= 1.0` per transaction over 7d with
  `>= 3` failing transactions -> 0.8 (71% gold / 26% cleared); any `>= 2` failures
  -> 0.45. No channel requirement, no baseline requirement.

**Why this is legitimate.** The policy rules are the *analyst's* action thresholds
(R5 says what to do when card testing is seen); the detector's job is to recognise
the pattern as it actually occurs in this data. A detector that matches the text
and misses every labelled instance is not faithful to the spec — the spec's own
pattern definition ("often under $5") already signals the number is illustrative.
The labelled cases are prior history, temporally before every benchmark case, so
measuring them is case memory, not leakage.

**Consequence.** Score tiers are unchanged (`tests/ws2/detectors.test.ts` pins
them), so the tier test still guards drift. Iteration-3 confusion matrix motivated
this: `card_testing -> card_not_present_fraud` 3/3 and `account_takeover` 0/3.

## Keep the `undocumented` ring gate at ≥80% anonymous-proxy uses (iteration 10)

Two benchmark-sample `undocumented` cases (CC-3907, CC-4124) are missed: their flagged device is
shared by 5 and 14 cards but has **zero** anonymous-proxy uses, so the ring rule never fires.
Measured over all 9 closed `undocumented` cases and ~300 sampled per other pattern
(30-day device window ending at `as_of`):

| rule | undocumented | cnp_fraud | cnp_new_device | account_takeover | card_testing |
|---|---|---|---|---|---|
| ≥5 cards & ≥80% anon-proxy | **4/9** | 0/290 | 0/292 | 0/25 | 0/16 |
| ≥5 cards | 8/9 | 221/290 | 240/292 | 21/25 | 14/16 |
| ≥5 cards & ≥30% new | 8/9 | 140/290 | 203/292 | 16/25 | 10/16 |

The proxy rule is the only one with any precision (100%). The non-proxy undocumented rings are
shaped exactly like ordinary card-not-present rings, which are ~2,500× more common, so loosening
the gate would label hundreds of CNP cases `undocumented` to catch five. Decision: keep the gate;
accept those five as undetectable from the graph. The assessor may still call them CNP fraud,
which is the right family.

## Kev as the pattern scorer: what it is asked, what it sees, what it learns from (2026-09-23)

**Trigger.** Iterations 11b, 12 and 12b missed the Kev bar (pattern 41.2% each, cleared 3/3).

**It answers one question: which of the five documented patterns.** Not fraud-vs-legitimate. In
`closed_cases_history` every cardholder dispute (4,665) was confirmed fraud and every model alert
(900) was cleared, so a model trained to separate fraud from legitimate there learns the trigger
kind. For the same reason the state leaves out the dispute text (`customer_response`) and the R7
line (runs only on disputes). The LLM keeps the fraud-vs-legitimate judgement.

**`undocumented` is not an option.** One undocumented case closed before the cutoff. The existing
graph gate (anonymous-proxy ring) still names it; `applyKevPatternScore` leaves an `undocumented`
hypothesis's mass untouched.

**Temporal split, not the backtest's stratified holdout.** A trained model carries every case it
learned from. Under the stratified split it would learn outcomes of cases that closed after the
as_of of cases it is scored on, which PRD §8.1 forbids. Train = confirmed fraud closed before
2016-09-01; eval and the end-to-end backtest (`BACKTEST_FROM`) = opened on or after it. The
backtest sample therefore changes from iterations 1–12b, so the current pipeline without Kev is
re-measured on the new sample before comparing.

**How Kev's answer enters.** `applyKevPatternScore` keeps the LLM's documented-pattern mass D and
splits D by Kev's distribution; `legitimate` and `undocumented` are unchanged, so fraud probability,
verdict and risk level are exactly the LLM's. Every narrative field is templated from the final
assessment, so summary, SAR and explanation name Kev's pattern consistently. Organiser's rule
(Devanshu): such models are fine "for routing and scoring inside your agent, but you will still need
an LLM for the actual answers" — Kev scores, the LLM judges fraud and the answer is built from that.

**One renderer for training and inference.** `renderKevState` builds the state from the same
EvidenceItems the assessor sees; the export stores raw evidence so a renderer change re-renders
instead of re-gathering.

## RAG similarity scored by TigerGraph; eligibility stays in TypeScript (2026-09-23)

`RAG_VECTOR_BACKEND=tigergraph` makes `retrieve_policy` and `retrieve_similar_cases` take their
cosine from the installed `vector_search` query over `PolicyChunk.embedding` / `FraudCase.embedding`.
The graph scores **every** case (`apply_as_of=false`) and `scoreSimilarCases` applies `visible_from
<= as_of` and the resolved-outcome rule as before. Reason: agent-written memory records are keyed by
the run's case id while their graph vertex is `GRAPH-<id>`, whose closed_at is the epoch default
unless the case closed, so a graph-side as_of filter would silently disagree with the tested local
one. An eligible record with no graph embedding throws (run `sync-graph`) rather than dropping out.
Local JSON stores remain the source of record text; the graph is the similarity index.

## R1 single-signal guard caps the fraud probability in code (2026-09-23)

docs/DATASET_README.md R1: "If the case rests on a single signal (including a risk score alone) and
your assessed fraud probability is below 0.70, recommend VERIFY_WITH_CUSTOMER or STEP_UP_AUTH before
any block." The local assessor defeated the premise: on cleared alert CC-0037 it put p = 1.0 on one
detector hit weighted 0.33, so the probability never fell below 0.70 and R1 never ran.

Decision: `agent/src/singleSignal.ts` counts independent fraud signals as distinct evidence
categories holding a fraud-supporting item with weight > 0.2 (pattern-shape items excluded — they
say which pattern, not whether fraud). With at most one, fraud mass is scaled to 0.69 (just under the
fraud line), keeping relative pattern weights, and the cap is recorded on `assessment_updated`.
This follows PRD §9.3 "LLM proposes; assess.ts enforces". It is a rule about evidence diversity taken
from the policy text, not a threshold tuned to the benchmark: the 0.70 comes from R1 itself.
Trade-off: a real fraud with one strong signal is now verified before being blocked, which is what
R1 asks for.

## Pattern 3 is decided by the device flag, in code (2026-09-23)

docs/DATASET_README.md defines card_not_present_new_device as CNP fraud "with the identity record
marking the device as New for this account". When the flagged online charge is New and the assessor
names plain card_not_present_fraud, `agent/src/patternRules.ts` moves that mass to the new-device
pattern (never changes the fraud total or verdict). Held-out check: the New-device shape appears on 0 of
400 plain-CNP cases. The reverse (known device → plain CNP) is *not* enforced: 19% of new-device cases
are flagged on a known device with other New-device charges in the case.

## Community incidence is compared with the history at the same as_of (2026-09-23)

A community's confirmed-fraud share of closed cases votes fraud only when it exceeds the share over all
cases closed by as_of (both computed in `community_lookup.gsql`, temporally filtered). The population
figure is not printed in evidence, to keep outcome base rates out of the assessor's context.

## Amount-structuring burst is `undocumented`, but R9's action triple needs "across customers" (2026-09-23)

**Context.** Gap analysis (subagent, read-only) found the 9 closed `undocumented` cases form two
clusters. Cluster A (cross-card anonymous-proxy device ring) was already detected. Cluster B — per
the analyst notes of the three design-set cases outside the 50-case backtest ("four online purchases
within forty minutes, each just under $500") — had no detector, so CC-3907/CC-4124 were filed as
`card_not_present_new_device`.

**Decision.** New `detect_patterns` block emits `undocumented` for ≥4 online charges inside one hour,
every one in [$400, $500), no other online charge interleaved, amounts spread ≥ $5. Designed on the
3 design-set cases only (3/3); 0 of 33 closed cases whose episode could fit the band fire, 0 of 900
cleared. The test-set pair (CC-3907, CC-4124) was checked only after the signature was fixed: both
match; CC-3035 (cluster A) correctly does not. Evidence weight 0.59 = 3/3 shrunk toward 0.35 with k=5
(design-set n only). The label gate (`resolvePatternLabel`) now accepts either graph finding.

**R9 scoping.** DATASET_README R9: "coordinated or repeated abuse **across customers**, recommend
`CREATE_CASE`, `FILE_REPORT`, and `ESCALATE_TO_ANALYST`". The burst is on one card, so R9's triple
now fires only for cross-customer findings (the proxy ring, or a `coordinated` detector). The burst
still counts for §3a's report test ("the pattern is coordinated or undocumented"), so a strongly
suspected burst gets CREATE_CASE + BLOCK_CARD + FILE_REPORT via R2/§3a — which is also exactly the
`actions_taken` on the three design-set cases. The §3a FILE_REPORT reason now names its real ground
(shared origin / undocumented / exposure > $1,000) instead of always quoting the shared-origin text.

## Unanswered verification is R4, and nothing about the reply is assumed (2026-09-23)

README §3b wants recommend → ask → recommend again; §5 says replies "are not provided" and asks
teams to simulate them. Per the standing no-fabrication rule we do not simulate a reply. The agent
now does ask (customer_validation is recorded in `evidence_requests` with "no reply received,
none assumed") and treats the unanswered request as what it is — no reply — so R4 governs the
final recommendation. This cannot reproduce the analysts' CLOSE_NO_FRAUD on cleared alerts,
which followed a real confirmation; that gap is accepted rather than closed with an invented reply.
R4's DECLINE_TRANSACTION applies to pending authorizations; the dataset has no authorization
status, so it is not recommended and the reason says why.

## Episode scope: risk-scored same-channel charges, 2h lookback (2026-09-23)

Measured against analysts' episode transactions on 2,406 held-out cases (see logs). The risk
score scopes an episode the case is already about; it never decides a verdict (README: "a reason
to look, never a verdict"). The lookback before the flagged charge is kept despite costing ~2
points on the history, because the history's alignment of alert and first fraud charge is a
property of how the backtest replays disputes, and the README warns it need not hold.

## Assumed cardholder confirmation (option B): measured, not adopted (2026-09-23)

The user preferred closing cleared alerts as `CLOSE_NO_FRAUD` under R3 with an assumed
confirmation (DATASET_README §5 permits simulating replies), on one condition: it must close no
fraud. That condition could not be met, so the honest no-reply path (R4) stays.

Why it cannot be checked on the history alone: every one of the 4,665 confirmed-fraud cases was
opened by a cardholder report and every one of the 900 cleared cases by a model alert, so the
history has no model alert that turned out to be fraud, which is exactly where an assumed
confirmation would act (11 of the 20 benchmark cases are model alerts). The backtest's new
`BACKTEST_AS_ALERT=1` mode replays fraud disputes as the alerts they could have been: the real
disputed transaction, its own risk score, as_of three hours after it (the modal alert delay), no
dispute text.

Result on 69 fraud cases replayed as alerts plus 45 real cleared alerts, none used before: among
cases the agent did not call fraud, the best available rule (no independent fraud signal and a
new-device pattern) would close 24 of 39 cleared alerts and 6 of 37 fraud cases. No rule reached
zero. An earlier search over 540 held-out evidence sets found the best zero-fraud rule covered 7
of 150 cleared cases on the same data it was searched on, which is too small to trust.

`CREATE_CASE` on cleared alerts follows §3a ("whenever you request evidence") over the analysts'
records (900 of 900 cleared cases list `VERIFY_WITH_CUSTOMER|CLOSE_NO_FRAUD` with no case). The
benchmark is scored against the written policy; our own action scorer should credit §3a.

Related fixes in the same batch: the low-probability "no pattern" close now opens a case when
p >= 0.30 (§3a), its reasons no longer claim customer records support the close, and L1/L2
actions stay PENDING_APPROVAL for a human instead of being reported executed.

## Model-alert probabilities come from calibrated evidence; a legitimate reading still asks (2026-09-23)

The local assessor's fraud probability does not separate the outcomes on model alerts: on the
alert replay it put all 45 real cleared alerts at 0.50 or above (6 blocked) and called none of
them legitimate, while `fraud_probability` is scored for calibration. The evidence does separate
them, so on a `risk_score` trigger the fraud mass now comes from an evidence model
(`agent/src/alertCalibration.ts`); the assessor keeps the pattern ranking.

- Fitted on 300 cleared alerts plus 305 confirmed-fraud cases replayed as alerts (design set),
  gathered with the agent's own tools, no LLM, none previously used. Logistic regression with sign
  constraints (a fraud signal may only raise the probability, a legitimacy signal only lower it),
  chosen on design cross-validation before any held-out look (AUC 0.851 vs 0.859 unconstrained;
  the unconstrained fit gave a fraud signal a negative weight). Five features carry the model:
  flagged charge online (+), flagged charge on a device new to the account (−), no prior cases (−),
  a device-identity fraud signal (+), a cleared case on the same card (−).
- Held-out check on 241 cleared alerts and 388 fraud-as-alert cases never used before, fitted on
  the design set only: AUC 0.909; predicted vs actual fraud rate 0.16/0.05, 0.36/0.28, 0.61/0.62,
  0.83/0.85, 0.92/0.91. After the R1 cap, verdicts would be: cleared 166 legitimate / 52 uncertain
  / 23 fraud; fraud 23 legitimate / 152 uncertain / 213 fraud.
- Prior: 1:1, the neutral choice. The history has no alert population with both outcomes (every
  closed alert was cleared, every fraud case a dispute), so no measured alert fraud rate exists;
  no benchmark answer distribution is used, and nothing is added to any prompt.
- Not applied when the graph shows an undocumented signature (proxy device ring, structuring
  burst): each is near-certain fraud in the history and never occurs in the design set. The proxy
  device ring is also exempt from the R1 one-signal cap: 4 closed cases, all confirmed fraud, none
  of the other 5,561. The evidence item states the sample is small.

A legitimate reading does not close the case. Closing on evidence alone failed the user's
zero-miss condition on held-out data (the strictest cutoff still closed 1 of 388 fraud cases), and
R3 closes on the cardholder's confirmation. So a legitimate verdict asks the cardholder
(`VERIFY_WITH_CUSTOMER`, §3a `CREATE_CASE`); with no reply R4 leaves it open under `MONITOR_CARD`.
`CLOSE_NO_FRAUD` and `ALLOW_TRANSACTION` are recommended only after a confirmation, which this
dataset never provides. Status is `closed_legitimate` only when `CLOSE_NO_FRAUD` was recommended.

## Episode scope from a per-transaction model, not one risk filter (2026-09-23)

**Context.** Exposure was within 25% of the analysts' on only 60% (fresh 50) and 52% (original 50)
of fraud cases, and it decides the report: analysts filed exactly above $1,000, and 8 of the 10
non-cleared action mismatches in iteration 22 were report decisions. By pattern, card-not-present
episodes were fine (31/37 within 25%) and card-present ones were not (account takeover 6/19,
out-of-region 9/18, card testing 0/5).

**Decision.** `agent/src/episodeModel.ts` scores each transaction from two hours before the flagged
charge onwards (logistic, 15 features the agent already holds: risk score, same billing region as
the flagged charge, a region the card had not used earlier in the window, amount within 5% of the
flagged charge, same identity-check flags, failed-check count, channel, device marker and so on)
and keeps rows at 0.4 or above; tiny online probes still always join an online episode (README
card-testing example). Undocumented activity keeps its channel-and-product scope.

**Evidence.** 2,710 held-out confirmed-fraud cases (none of the 100 backtest cases; verified),
split by case id. Chosen on design-half cross-validation; check half scored once with the model
fitted on the design half: exposure within 25% 65% -> 74%, wrong side of $1,000 7.0% -> 5.2%,
account takeover 64% -> 73%, out-of-region 60% -> 75%, card-not-present 78% -> 83%, card-not-present
new device 74% -> 71%. The TypeScript scope reproduces the Python selections on all 2,696 cases.

**Not done.** Card testing: 9 cases outside the backtest, and the analysts' rows and the rest are
both online product-C charges on busy cards; nothing to fit. A separate model per flagged channel
added about 1 point on design CV and was not worth the second weight table.

## Filed fraud probability never claims certainty (2026-09-23)

`fraudProbability` (`agent/src/assess.ts`) now bounds the filed value to [0.01, 0.99]. The
assessor filed HHG-014 at 1.00 by putting 0 on the legitimate reading, while the signal behind it
(the proxy-device ring) has 4 historical cases; certainty is not supported by a finite history,
and calibration scoring punishes a confident miss hardest. Every policy threshold (0.15, 0.30,
0.40, 0.70) lies well inside the bounds, so no verdict or action changes; only the reported number
stops overstating certainty. The bounds are a general guard, not fitted to any case set.

The §6 stop reason (`agent/src/stopRule.ts`) now quotes that same filed probability and names the
leading pattern's share separately ("Fraud probability 0.99 (leading reading
card_not_present_new_device at 0.87) ..."). It used to print the leading pattern's share as the
fraud probability, so the stop reason and `fraud_probability` disagreed (HHG-014: 0.87 vs 1.00).
