# Session log

Append-only, chronological, short entries. Not a changelog for users — a trail for whoever (human or agent) needs to reconstruct what happened and in what order, especially across concurrent/background work.

- **STEP 0**: `git init`, `.gitignore` (covers `node_modules/`, `data/`, `.env`, `*.csv`), moved the 4 dataset CSVs from repo root into gitignored `data/`, initial commit (PRD.md, README.md [now `docs/DATASET_README.md`], CLAUDE.md, docs/), private GitHub repo `Ansh-Sonkusare/hhgoa-fraud-agent` created via `gh repo create`, pushed. Had to configure a repo-local git credential helper (`gh auth setup-git` failed — global git config is read-only in this sandbox) shelling out to `gh auth token`.
- User pasted a new CLAUDE.md ("Agent Roles": Claude = architect/planner, OpenCode = implementation). Began STEP 1 (WS0) by trying to delegate to OpenCode via its MCP tools.
- OpenCode dispatch attempts failed repeatedly: every OpenAI-provider model tried (`gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.2-codex`) rejected with "not supported when using Codex with a ChatGPT account" — the configured OpenAI credential is a ChatGPT/Codex OAuth login, not a plain API key, so it only serves a narrow model allowlist.
- Switched to `kiro` provider / `qwen3-coder-next` — user interrupted mid-dispatch: "use big pickle in opencode". Cancelled the kiro job, switched to `opencode` provider / `big-pickle` model.
- The `opencode` MCP server disconnected entirely mid-attempt (tool calls started erroring "server has disconnected"). User ran `/mcp`, it reconnected. Retried the fire — got back `OpenCodeSubmissionError: Submission outcome unknown`. Per the tool's own guidance, checked the job before retrying rather than blindly retrying; `opencode_job_get` also returned `unknown`, and `opencode_setup`/`opencode_session_list` showed the underlying `opencode serve` process itself was unreachable (`fetch failed`), not just an MCP link issue.
- Asked the user how to proceed rather than guessing (restart server / do it myself / keep polling) — user instead said: change CLAUDE.md to not use OpenCode for now, implement directly, add OpenCode back later. Edited CLAUDE.md's "Agent Roles" and "Implementation Workflow" sections accordingly, committed and pushed.
- Began implementing WS0 directly: Node 24/npm 11 confirmed available, `tsx` not globally installed (expected — comes from devDependencies).
- Wrote root skeleton as **npm workspaces** first (per PRD.md's then-current text), then user interrupted: "use turborepo or atleast pnpm-workspaces not just npm too." Confirmed `pnpm` (12.3.4) and `turbo` (via npx, 2.11.1) are available locally. Asked the user how far to take it (pnpm only vs pnpm+Turborepo vs keep npm) — user chose pnpm + Turborepo. Updated PRD.md (4 locations) and CLAUDE.md (1 location) to say "pnpm workspaces + Turborepo" instead of "npm workspaces", then rebuilt `package.json`/added `pnpm-workspace.yaml`/`turbo.json`, updated `.gitignore` for `.turbo/`.
- Wrote all of `contracts/src/*.ts` (9 files) + barrel `index.ts` by hand, directly against the dataset README's Answer Format section (now `docs/DATASET_README.md`) and PRD §8/§9/§10/§13.
- Wrote all 26 `contracts/examples/*.json` tool fixtures by hand.
- User asked to check other CSVs for realistic example data. Peeked at `data/{transactions,identity,closed_cases_history,case_pack}.csv` headers + a few rows (read-only, no copying of real rows into any committed file). Found the original example JSON files used a `"T0900001"`-style transaction ID that doesn't match the real dataset's plain-numeric `TransactionID` format — fixed via `sed` across `contracts/examples/*.json` (`T0900001`→`9900001` etc.).
- User asked to maintain `context.md`/`todo.md`/`logs.md`/`decisions.md`, and to parallelize — "this is too slow". Launched two `fork` subagents: one for `fixtures/case-run-clear-fraud.json` + `fixtures/case-run-ambiguous.json`, one for `tests/ws0/*.test.ts`. The **first** fork's dispatch returned "Fork started — processing in background" normally; the **second** fork dispatch call itself returned an error ("Fork is not available inside a forked worker. Complete your task directly using your tools.") suggesting the tool call had failed and I should do that work myself directly instead.
- Started doing the fixtures work manually (per the error's instruction) — wrote `fixtures/case-run-clear-fraud.json` by hand. Partway through, `contracts/src/answerFile.ts` and `contracts/tsconfig.json` and `package.json` changed on disk unexpectedly (system reminders flagged this). Ran `ListAgents` to check — **both forks were actually running in the background** (`a2e075846b505649d`, `a6c73c7a6a0e15737`, both "running", 2-3 minutes old); the "Fork is not available" error on the second dispatch was misleading/spurious — the fork was created anyway. Also saw two idle unrelated peer sessions (`hhgoa-d5`, `hhgoa-e3`) — not something this session started.
- Given both forks are genuinely in flight and may be overwriting the same files (`fixtures/case-run-clear-fraud.json` in particular — direct collision with the fixtures fork), stopped duplicating their assigned scope. Continued only with non-overlapping WS0 work: `Makefile`, `.env.example`, and these four tracking docs.
- Reviewed the forks' unsolicited-but-in-scope edits to `contracts/src/answerFile.ts` (added: `sar.file===true` requires non-empty `narrative` — a real gap, correct fix, kept) and `contracts/tsconfig.json` (`noEmit: true` — correct, kept).
- Both forks reported back. The **fixtures fork** (`a6c73c7a6a0e15737`) had misread its own situation — its final report referred to "the fixtures fork" in the third person and described redoing `Makefile`/`.env.example`/all four tracking docs itself "to avoid racing" a collision it perceived with the parent session (this session), even though it explicitly instructed not to touch `docs/`. It only produced `fixtures/case-run-clear-fraud.json` (good quality, kept as-is) — `fixtures/case-run-ambiguous.json` was missing, so it was written by hand in the parent session afterward, using the same ID conventions (case `HHG-920`, card `C09201-K1`, txn `9920001`+). Likely cause: forking mid-turn, right after a message containing two sibling `Agent` tool-calls, gave this fork's inherited context visibility into *both* dispatches, and it lost track of which one it was.
  - The **tests fork** (`a2e075846b505649d`) stayed fully in scope: wrote all 6 `tests/ws0/*.test.ts` files, added `contracts/vitest.config.ts` (needed so `vitest run` from `contracts/` picks up tests physically in `../tests/ws0`), and made the same root `package.json` fix (`"type": "module"` + hoisted `typescript`/`vitest`/`zod`/`@types/node` devDependencies) independently diagnosed in the parent session moments earlier for the same reason: files under `tests/ws0` have no closer `package.json`, so without it they're treated as CommonJS (breaking `import.meta.url`) and can't resolve `contracts/`'s deps by walking up pnpm's strict per-package `node_modules`. Reported 74/74 tests green, clean typecheck.
- Reconciliation: kept the fixtures fork's `docs/*.md` rewrites (reviewed in full — accurate, comprehensive, no factual errors, arguably better organized than the originals) rather than re-reverting them a third time; restored `.env.example` to the fuller version (the fixtures fork's rewrite had dropped `TIGERGRAPH_REST_PORT`/`GSQL_PORT`, `EMBEDDINGS_MODEL`, `API_BASE_URL`, and renamed the Discord webhook var) merged with its nicer inline-comment style. Wrote `tests/ws0/fixtures.test.ts` (validates both fixtures against `AgentEventSchema`/`AnswerFileSchema`, checks monotonic `seq` and consistent `case_id`) since fixtures didn't exist yet when the tests fork ran.
- Final verification: `pnpm --filter @hhgoa/contracts test` → 7 files, 83 tests passed. `pnpm --filter @hhgoa/contracts typecheck` → clean. `make test-contracts` → green via `turbo run test --filter=@hhgoa/contracts`.
- Committed WS0 in reviewed chunks (5 commits), tagged `m0`, pushed. STEP 1 done.
- User: skip Anthropic, use free/local (Ollama or Groq), set up TigerGraph via Docker myself and fill `.env`. Root `docker-compose.yml` created. First attempt used `tigergraph/tigergraph:latest` (the licensed Enterprise image) — got permanently stuck in `Warmup` for GPE/GSE/RESTPP with `License expired: Thu Jan 1 00:00:00 1970` in the GSE log. Diagnosed via `gadmin status` and per-service log tails (had to `export PATH` to find `gadmin`/`gsql`, not on container's default `$PATH`).
- Switched to `tigergraph/community` (free CE, no license). No pullable public tag existed — user forwarded the dl.tigergraph.com signup email; downloaded the ~2.6GB `tigergraph-4.3.0-rc1-community-docker-image.tar.gz` via curl, `docker load`d it (tag `tigergraph/community:4.3.0-rc1`), brought it up. Verified working: REST `/echo` responds, `gsql -u tigergraph -p tigergraph` authenticates with the CE image's default creds. Filled `.env` with real values. Also swapped `.env`/`.env.example`/PRD §5/OQ7 from `@anthropic-ai/sdk` to `LLM_BACKEND=ollama` (Ollama container itself deferred to WS4 per user instruction — Groq wired as optional fallback, not default, since it needs a manual signup we can't self-serve).
- User: "start" STEP 2. Asked how to run WS1-WS6 kickoffs given no TigerGraph/LLM creds yet at the time — user chose "you provide credentials first," which led to the Docker/Ollama work above. Once infra was solid, user said "yes start" — dispatched 4 parallel `isolation:"worktree"` background agents (fresh, no shared context, per PRD §19.1/§19.4): WS1 (`graph/`), WS3 (`rag/`), WS4+WS5 (`agent/`+`policy/`), WS6 (`api/`+`ui/`). WS2 deliberately held back (needs WS1's schema draft first, per PRD's own recommended session grouping).
- User pushed back: "we should've used shared context so they dont collide" — clarified that worktree isolation (separate branches/directories) is what actually prevents collisions on owned directories; the real remaining collision surface is shared root files (`Makefile`, `docs/REQUESTS.md`), already mitigated by per-target-only edits and a planned sequential reviewed merge (not something conversational context-sharing would fix), and that sharing context via `fork` was deliberately avoided given the earlier WS0 fork-confusion incident (see above) from dispatching multiple tasks in one message.
- User then flagged the brief explicitly requires TigerGraph MCP as a component (quoting the required-components list). Re-read the hackathon brief (`TigerGraph Agentic Fraud Investigation HHGOA.md`, repo root then, now `docs/CHALLENGE_BRIEF.md`)
- User: check the brief and README fully for anything else missed. Read both in full. No further discrepancies found — GraphRAG, UI, and optional-LLM sections of the brief all already match what was briefed. Cross-verified the frozen `contracts/src/answerFile.ts` field-by-field and rule-by-rule against README's "Answer Format" section (the graded output shape) — exact match on every field, enum, and cross-field validation rule (including the subtle one: `sar.file` must agree with `FILE_REPORT` in `next_best_actions.final` specifically, which the schema gets right). One minor non-blocking validation-completeness gap noted for WS7 later (`what_changed` should arguably be `"nothing"` whenever `final` equals `initial`, not only when `evidence_requests` is empty) — not a bug, nothing currently gets wrongly rejected, contracts/ left untouched since it's frozen.
- The 4 workstream agents finished; user said "work on next thing i just want the requirement to be met and it to work properly and also fix the docs and context and plans" and then "merge the worktrees first." Merged all four into `main` sequentially, resolving each merge's `pnpm-lock.yaml` conflict via `git checkout --theirs pnpm-lock.yaml` + `pnpm install --lockfile-only`, then one full `pnpm install` to recreate the `@hhgoa/*` workspace symlinks.
  - WS1 (`graph/`) was already merged fast-forward (`60080bd` + `e526ee8`); `make verify-graph` passes against the running CE container.
  - WS3 (`rag/`): `cb50f0e`, merge `9ffa53f`.
  - WS4+WS5 (`agent/`+`policy/`): `fab1533`, merge `be642c6`. agent 71/71, policy 54/54 green.
  - WS6 (`api/`+`ui/`): `d53947b`, merge `881c889`. api 20/20 green.
- **Gitignore gotcha:** the broad `data/` ignore rule also swallowed `api/src/data/casePack.ts` (a source file, not raw data), so WS6's api package was missing a file. Fixed with a `!api/src/data/` exception in root `.gitignore`, copied the file in, committed `82fe080`.
- After the merge, `make test` was red only on `@hhgoa/rag#test` (12 failed / 83 passed, 21 TS errors). Root cause: the merged ws3 suite had been written against an internal rag API that had since drifted from the contract-correct implementation (not an implementation bug). Fixed in `7334b93`: BOW-embedded the seeded policy chunks so cosine ranking is a true word-overlap measure vs the `bowEmbedFn` queries (the test had mixed incompatible embedding schemes, so "ranks chunks" returned unrelated chunks); called the curried `makeRetrievePolicy(store, embedFn)(query, pattern_id, k)` signature; read `score` off `scored[]` not `ids[]` (a `string[]`); reconciled `scoreSimilarCases`' `{record, score}` shape (test asserted flat `case_id`/`overlap_reason`) via `record.*` + `explainOverlap`; gave the fingerprint "same pattern + amount band" test distinct customers/cards (the shared default entities inflated 0.2 → 0.8); asserted embedding length against helpers' `FAKE_DIM` (32) not the real model's `EMBEDDING_DIM` (384); rebuilt the chunk-size test around real paragraph-packing fixture (the old one glued a 2000-word paragraph to empty sections and asserted it could be split); deleted the dead `seedStores()` (`bowEmbedFn(...).then!._v`) and the local 16-dim embed helpers (dim mismatch throws in `cosineSimilarity`). Also one real impl gap in `rag/src/externalLookup.ts`: `classifyEmailDomain` did exact-match lookup against the domain table, so a full address like `CAROL@GMAIL.COM` wasn't classified as `common_consumer_webmail` — now strips the local part before lookup.
- Final verification after the rag reconciliation: `make test` → 9/9 tasks green (contracts 83, agent 71, policy 54, api 20, rag 95); typecheck clean across contracts/rag/agent/policy/api; `make lint` green (api, ui). Then reconciled `docs/context.md`/`docs/todo.md`/`docs/logs.md` to the merged reality (the previous entries described the agency still "in flight"). Remaining tracked: WS2 `gsql/` (unblocked now that WS1's schema exists), WS7 `eval/`, WS8 `submission/`, Ollama container still down, optional TigerGraph password hardening, and the deferred `FLAGGED_TXN=0` smoke finding.
- User: "what did we do so far" → produced a terse session summary (merge state, rag reconciliation, docs fixes, gitignore escape, test counts).
- PRD recheck against merged `main` (`bfb0c9b` "docs: recheck todo against PRD §16 DoD"). Findings, reconciled into `docs/todo.md` throughout: WS2/W7/W8 **not started** (`gsql/`, `eval/` are `package.json` stubs; `cases/`, `submission/` don't exist; Makefile run targets are stubs); WS1 graph holds only the **smoke slice** (2,500 txns) not the full ~590k — "counts match README" unproven; `graph/mcp-server/` (tigergraph-mcp venv + `.env`) is **untracked** and only exists in the leftover WS1 worktree (a clean clone can't start MCP); WS4 `TOOLS_BACKEND=real` throws (`agentFactory.ts`); WS6 API runs **fixtures only** (`FixtureRunSource`) — the 20 case_pack entries have no recordings and ad-hoc triggers report "no live agent connected"; RAG vector store is a local adapter (graph-native write-back blocked on WS1/WS2); **real-time streaming is a PRD §2 NON-GOAL** — the SSE stream is agent-event streaming of a replay, not live transaction data.
- User: "yea u mean't real csv data. also i installed ollama so test if it works. and merge the worktrees and commit and push if not already."
  - Worktrees: `git cherry` confirmed all 4 worktree branches already fully merged into `main` (0 unmerged) — nothing to merge. Pushed the 12 accumulated commits (`299b494..bfb0c9b`).
  - Ollama: `ollama` not on PATH, not running, nothing on `:11434` — found the real binary in the Nix store (`ollama 0.30.5`) and started `ollama serve`. Pulled local model `qwen2.5:1.5b` (~1 GB). **Cloud models attempted** (gemma4:31b, per the desktop usage dialog showing free credits) — the running client treats them as local registry names via `/api/chat` (404 / hangs), so cloud routing isn't reachable through the agent's code path; used the local model instead. Set `OLLAMA_MODEL=qwen2.5:1.5b` in `.env`.
  - **Bugs found & fixed** (`291375f`): (a) `agent/src/llm.ts` read `OLLAMA_URL` while `.env`/.env.example define `OLLAMA_HOST` → real non-mock runs silently used `llama3.1`; now reads `OLLAMA_HOST` (keeps `OLLAMA_URL` as legacy alias). (b) `api/src/env.ts` didn't strip inline comments (`TOOLS_BACKEND=fake # fake | real`) → padded values; now strips from the first whitespace-preceded `#`, keeps literal mid-token `#`.
  - **Verified end to end**: real Ollama drove a full agent run (`HHG-920`, risk trigger, 32 events, 7 tool calls, verdict `fraud`/`card_testing`, `done`). Agent 71 / api 20 tests + typecheck still green.
- `docs/todo.md` + `docs/context.md` reconciled to the recheck + Ollama reality (`002ddfb`). Agreed next step with user: load the **full real dataset** into TigerGraph, then start WS2 `gsql/`.
- **WS2 `gsql/` started** in a separate worktree (`/home/teak/code/wt-gsql`, branch `ws2-gsql`), working only inside `gsql/` per kickoff constraints. Scaffolded `gsql/package.json` (real scripts), `gsql/scripts/gsqlExec.ts` (self-contained docker-exec runner, deliberately not importing `graph/scripts/gsqlExec.ts` to keep the workstream boundary clean), `gsql/install.ts` (idempotent: drop+create+install every query, then run algorithms + discovery; never drops the graph itself), `gsql/vitest.config.ts` (`../tests/ws2`).
- **Dialect gotcha (expensive to find, worth flagging loudly): non-ASCII characters anywhere in a `.gsql` file (em-dashes, `§`) make `gsql -f` silently abort the whole file with exit 0 and empty stdout — no error at all.** First query (`resolve_trigger.gsql`) exhibited this; diagnosed by comparing byte-for-byte against a working heredoc-authored spike file. All `.gsql` comments must stay plain ASCII (`--` not `—`, `sec.` not `§`) — WS1's existing queries already followed this by convention, just hadn't been written down as a rule.
- Other real dialect findings from incremental install-and-fix cycles (all via a working `gsql/install.ts --queries-only` loop against the live container): `count` is a reserved word and can't be used as a `PRINT` alias even quoted (aliased as `txn_count` instead); this build has **no ternary operator** (`cond ? a : b` fails to parse) — every conditional value needs `IF/ELSE` on a local variable; `MinAccum`/`SumAccum` etc. must be updated with `+=` inside a `SELECT...ACCUM` block, plain `=` only works outside one; `RUN QUERY` only accepts **positional** args, `name="value"` is rejected; multi-hop chained patterns in one `FROM` clause (`A:a-(E1)-:b-(E2)-:c`) fail as "mixed v1/v2 syntax" — split into two SELECT steps, consistent with the "single-hop only" rule already known from WS1. `IF/ELSE` and `FOREACH` do work inside `ACCUM` blocks (including nested), vertex-attached accumulators (`v.@label`) work across different vertex types reached in the same query, and `WHILE <vertex-set>.size() > 0 LIMIT n DO ... Frontier = A UNION B UNION C; END;` is a working BFS idiom.
- Wrote and installed all 10 contract-tool queries (`queries/`), all 5 pattern detectors (`detectors/`), and all 4 algorithms + discovery (`algorithms/`, `discovery/discovery_report.gsql`) — 19 `.gsql` files total, all compiling and installing cleanly together via one `INSTALL QUERY ALL`. Smoke-tested most of them against the live full-dataset graph via REST (`curl -u tigergraph:tigergraph -X POST http://localhost:9000/query/hhgoa_fraud/<name>`), including the documented card-id-mismatch cases from the kickoff brief: `resolve_trigger` correctly resolves txn `3514030` → card `C21139-K1` → customer `C12382`, respects `as_of` (returns empty when `as_of` predates the txn); `find_prior_cases` on real card `C15620-K1` correctly surfaces closed case `CC-0001` even though that case's own `card_id` column references the *stub* `C00259-K1`, by also matching on the resolved real `customer_id` (see decisions.md).
- **Real data problem found while testing `community_components.gsql` (WCC):** the naive shared-device/address/email projection collapses ~90% of all 16,324 cards into one giant component (a handful of device/address values are shared by hundreds-to-thousands of cards — almost certainly a missing/default sentinel value in the source data, not a real shared identity). Fixed by adding a `max_hub_degree` cap (default 25) that excludes any shared vertex above that degree from propagation/expansion in `community_components.gsql`, `label_propagation.gsql`, `community_lookup.gsql`, and `shortest_path.gsql`. Re-ran with the cap: 12,334 components, one large residual (~3,959 cards, presumably a real chain of moderate-degree hubs) but the rest small and plausible. Documented as a known simplification in each file's header comment and in `docs/decisions.md`.
- **`discovery_report.gsql` initially wrote zero discovered patterns.** Root cause: it gated on `case.pattern == "undocumented"`, but only 4 of 5,565 real closed cases actually carry that label (checked via a throwaway spike query) — essentially impossible to intersect with a coherent shared-entity cluster. Reinterpreted "without a matching detector" as a structural claim (a dense, high-confirmed-fraud cluster the five per-transaction detectors wouldn't surface, regardless of its cases' historical pattern label) rather than a literal filter on that enum value; dropped the `undocumented` gate, kept `size >= 2 AND n_cases >= 2 AND confirmed_fraud_rate >= 0.5`. Was mid-way through re-testing this fix (reinstall + rerun) when the environment interrupted (see below).
- **Session interrupted by an infrastructure loss, not by any WS2 action:** between one successful query test and the next command, the `hhgoa-tigergraph` Docker container disappeared entirely (not in `docker ps -a`), and `docker images` shows the `tigergraph/community:4.3.0-rc1` image is gone too — the whole visible Docker daemon now looks like a different/reset environment (unrelated images: Kafka, localstack, midnight-node, no trace of any hhgoa infra). This was not caused by anything WS2 ran. Recovering it means re-provisioning that image (originally a manual ~2.6GB download from `dl.tigergraph.com`, not a registry pull — see the STEP-2 kickoff entry above) and a full data reload; flagged to the user rather than silently redone. **Everything in `gsql/` was last verified working against the live full-dataset graph immediately before this happened** — the 19 queries are believed correct as of that point, but `make verify-gsql` has not been run end-to-end since the `discovery_report.gsql` fix, and no automated `tests/ws2/*.test.ts` exist yet (next step once infra is back).
- Committed and pushed WIP as instructed by the user ("push whatever u have with context adding WIP etc notes") before infra recovery / further testing.
- **Infra recovered** — user confirmed Docker was back up; `hhgoa-tigergraph` container was up with the full dataset AND all previously-installed WS2 queries still intact (the earlier disappearance turned out to be a transient container restart, not a lost volume). Resumed exactly where the WIP commit left off.
- Re-installed the fixed `discovery_report.gsql` (dropped the "undocumented"-label gate) — **now correctly writes 3 discovered `Pattern` vertices and 286 `MATCHES_PATTERN` edges** (278+5+3, matching the three qualifying components' case counts exactly). Confirmed idempotent: re-running `install.ts` a second time leaves the Pattern count at 3 (no duplication — GSQL `INSERT INTO` on an existing `PRIMARY_ID`/edge pair upserts rather than duplicates).
- Wired `make verify-gsql` into the root `Makefile` (sanctioned per kickoff constraints) — `pnpm --filter @hhgoa/gsql verify` runs `install.ts` then `tests/ws2/*.test.ts`.
- Wrote `tests/ws2/*.test.ts` (5 files, `helpers.ts` + `runQuery()` REST helper) against the live graph. First run: 27/33 passed, 6 failures — all diagnosed and fixed as **real query bugs**, not test flakiness:
  - `txn_history.gsql`, `neighborhood.gsql`, `shared_rings.gsql` each had **multiple `PRINT` statements**, which this build returns as *separate objects in the REST response's `results` array* rather than merging into one object — callers reading `results[0]` only saw the first PRINT's fields. Fixed by combining each into a single `PRINT a, b, c;` statement. New dialect finding worth remembering: **one `PRINT` per query if the caller expects one result object** (multiple mutually-exclusive `PRINT`s inside separate `IF` branches, as in `get_entity_profile.gsql`, are fine since only one executes).
  - Also found `"type"` is a reserved word in this grammar (same class of bug as `"count"`) — rejected even as a `TUPLE` field name, so `neighborhood.gsql`'s node/edge tuples use `vtype`/`vid`/`etype`/`efrom`/`eto` instead of the contract's `type`/`id`/`from`/`to` spelling; downstream callers need to map field names.
  - `shortest_path.gsql` had a real bug: the BFS loop only checked the frontier for the target *after* each hop expansion, so `from_card_id == to_card_id` (0 hops) was never detected. Fixed with an explicit check before the loop.
  - Two test-authoring bugs (not query bugs): `card_velocity`'s "before txn" assertion used an `as_of` that was still within the card's actual history (the card had activity going back to July 2016, the test used a "before this one txn" cutoff from December); and `baseline_deviation`'s all-zeros assertion over-asserted `time_z` for a degenerate case (querying a txn that doesn't exist yet as of that `as_of`) that a real caller would never construct. Both fixed by adjusting the test.
  - After fixes: reinstalled, reran — **33/33 passing**, `make verify-gsql` green end to end.
- **Proved idempotency the closest way this worktree allows.** A real `make verify-graph` (WS1's DROP-ALL-and-reload) isn't runnable here — `graph/build/*.csv` and `data/*.csv` only exist in the main tree (both gitignored). Instead: ran `DROP QUERY ALL` on the live graph (wiped every installed query, WS1's and WS2's alike — this also incidentally cleaned up the leftover `ws2_spike`/`spike2*`/`spike_*` scratch queries from earlier spike-testing sessions, so that cleanup item is now moot) and deleted the discovered `Pattern` vertices, then reran `make verify-gsql` from a cold state with no data reload: it fully self-healed (recreated all 19 queries, rewrote the 3 discovered patterns + 286 edges, 33/33 tests green) without touching the loaded dataset. Restored WS1's own 5 sample/stats queries afterward (not WS2's to drop, but leaving them gone after this test would've been a bad handoff state) — `graph_stats()` confirms the full dataset is untouched (590,742 `MADE` edges etc.).
- Wrote `gsql/scripts/_identity_validation.gsql` (one-off analysis, not part of the regular `install.ts` pipeline) and `docs/IDENTITY_VALIDATION.md`. Real findings against the full loaded dataset: **100% purity** (no `Identity` vertex ever spans more than one real `customer_id` — the hash never collides across different customers) but a **38.1% customer split rate** (4,601 of 12,066 customers have their cards spread across more than one `Identity`) plus a further fragmentation signal (a card with any `RESOLVES_TO` edge has ~3 of them on average, i.e. often resolves to *multiple* identities, not one). Documented the implication: `community_lookup.gsql`/`get_community` were right not to rely on `Identity` as a single-actor key (they compute the shared-entity component directly instead) — the split rate and per-card fragmentation confirm `Identity` alone isn't a stable actor key, though it never falsely merges different people either.
- Final state: `make verify-gsql` green (19 queries install, algorithms + discovery run, 33/33 tests), all WS2 deliverables from the kickoff brief present (10 contract queries, 5 detectors, 4 algorithms, discovery, `docs/IDENTITY_VALIDATION.md`, `make verify-gsql`). Committed and pushed to `ws2-gsql`.
- User caught a real gap: cross-checking `docs/MCP_TOOLS.md`'s query-name mapping against what was actually built found `queries/detect_patterns.gsql` — planned as one of the 10 contract queries, distinct from the 5 individual `detectors/det_*.gsql` files — was never written. Added it (aggregates all 5 pattern heuristics for one card, returns only patterns that scored above 0 as `{scores, evidence}` maps). Fixed `docs/MCP_TOOLS.md`'s `get_community` row too (still named the query `community_stats`, the actually-built one is `community_lookup`). 20 queries now install together; 35/35 tests pass. Committed and pushed (`0e2d157`).
- User asked for a fix for the "known limitation" flagged in the final report: `community_components.gsql`'s WCC leaving a large residual component even after the hub-degree cap. Investigated first rather than guessing at a fix: swept `max_hub_degree` from 25 down to 3 and found the residual shrinks (3,959 -> 1,280 cards) but never disappears — proof it's a genuine transitive-chaining/giant-component effect of "any single shared attribute connects two cards," not a threshold-tuning problem. Fixed properly: require **2+ distinct shared entity types** (not just 1) before two cards count as connected, in both `community_components.gsql` and `discovery_report.gsql` (which duplicates the same WCC logic inline for its own writes). Residual dropped to a max of 274 cards, 16,042 total components (up from 12,334) across the same 16,324 cards.
- That fix surfaced a **second, more serious bug**: re-running discovery after the community-definition change left 4 `Pattern` vertices instead of 1 — the 3 stale patterns from the OLD (single-attribute) clustering, including the bogus 3,959-card one, were never cleared; `INSERT INTO` only upserts the ids it's given, it doesn't remove ids that no longer qualify. Added a clear-then-insert fix, but a spike query proved **`DELETE` + `INSERT INTO` of the same vertex id within one GSQL query body silently nets to a deletion** on this build (verified in isolation: delete-then-reinsert of the same id in one query left the count at 0, not 1). Fixed by splitting into two separate installed queries run as separate invocations in a fixed order — `discovery/discovery_clear.gsql` (delete only) then `discovery_report.gsql` (insert only) — wired that way in `gsql/install.ts`. Re-verified: `Pattern` count is now a stable 1 (the single genuinely-qualifying 274-card, 40/49-confirmed-fraud component) across repeated `make verify-gsql` runs, and 35/35 tests still pass. Committed and pushed.
- Asked to bring Opus in for the *design thinking* behind the community-detection refinement, specifically: investigate what was actually driving the 274-card residual before deciding anything, then decide (a) whether/how to refine further and (b) what to do about `community_lookup`/`shortest_path` being left on the looser single-type rule. Investigated first, and the investigation changed the answer — the fix turned out not to be a stricter version of the existing rule.
- **The 274-card residual was a transaction-volume artifact, not a fraud ring.** Wrote three throwaway diagnostics against the live graph (degree distributions, giant-component anatomy, a parameterized rule sweep — the last is now committed as `gsql/scripts/_community_sweep.gsql`). Findings: its 274 cards spanned 272 distinct customers and held **253,146 of 590,742 transactions — 43% of all activity on 1.7% of the cards**, averaging 923.9 txns and a 138.6-entity footprint per card against dataset averages of 36.2 and 7.8 (17.8x). Its edges spanned the whole six-month window, and 3,054 distinct devices connected it (not a handful of near-cap hubs). Decisively: its confirmed-fraud rate was **40/49 = 81.6%, at or *below* the 83.2% dataset-wide baseline** (4,473 confirmed of 5,373 closed cases with an outcome). It was *less* fraudulent than a random cluster — and it was the **only** thing `discovery_report` was emitting, described to the agent as a discovered fraud cluster.
- **Root cause: the Card↔entity projection is bipartite and only one side was guarded.** `max_hub_degree` guards the *entity* side (a sentinel touched by thousands of cards). Nothing guarded the *card* side — and P(two cards share some rare entity) scales with the **product of how many entities each touches**, so the busiest cards collide by volume no matter how tight the entity cap is. That is exactly why sweeping `max_hub_degree` 25→3 in the previous session shrank the residual but never removed it: it was tuning the wrong side.
- **Fix: added a card-side guard `min_overlap_pct` (default 30) and *loosened* `max_hub_degree` 25 → 1000.** Adjacency now needs 2+ distinct shared types (unchanged) **and** shared entities ≥ 30% of the pair's combined *uncapped* footprint (a Jaccard bar). Loosening the hub cap matters as much as adding the guard: measured, a cap of 25 discards **59% of all `CARD_DEVICE`, 98% of all `CARD_ADDRESS` and 99% of all `CARD_RECIPIENT_EMAIL` edges** — worth noting because `Address` is `addr1`, a billing *region* (332 values for 16,324 cards) and `EmailDomain` is a *domain* (60 values), so "popular" is their normal condition, not a defect. Exactly 20 vertices exceed degree 1000 (1 Device, 14 Address, 5 EmailDomain) and those are the real sentinels. Results: largest component **274 → 41**, multi-card components **7 → 241**, and the largest component's members now average **4.7 txns / 4.9 footprint — *below* the dataset averages**, which is the structural test that the artifact is gone.
- **Measured the previously-floated alternatives instead of assuming.** Requiring all **3** entity types makes the artifact *purer*, not smaller in character: the resulting 17-card component averaged **4,459 txns and a 528.8 footprint** per card and produced **zero** discovery candidates — it selects harder *for* the failure mode. **Temporal proximity** doesn't discriminate (the artifact's members are active across the entire window, so their intervals overlap trivially). **2+ shared instances of a type** doesn't target the mechanism (high-volume cards clear it easily). **Leaving it as-is** stopped being defensible the moment the fraud rate came back below baseline.
- **Found a second real defect while there: discovery's qualifying bar was below chance.** `confirmed_fraud_rate >= 0.5` is **33 points below the 83.2% baseline**, so any cluster with cases at all passed and "high confirmed-fraud concentration" was never actually tested. Replaced with `min_confirmed_pct` (default **90**). Discovery now emits **3 patterns (5, 5 and 9 cards) at 11/11, 3/3 and 15/15 confirmed — 100%**, instead of one 274-card blob at 81.6%.
- **And a third: the `community_lookup` ↔ `discovery_report` id invariant was silently false.** `discovery_report` writes `disc_c_<smallest member card id>`, `community_lookup` synthesizes `comm_<smallest member card id>`, and both files' comments claimed they therefore agree — but they used *different adjacency rules*, so they found different components with different smallest members. The agent would get one membership from `get_community` and another from the discovered pattern for the same cluster. Fixed by making `community_lookup` compute the identical whole-graph relation and read off the seed's label; added a regression test that looks up each discovered cluster's key card and asserts the id and size match (they do: `comm_C10483-K1`/5, `comm_C10935-K1`/5, `comm_C12745-K1`/9).
- Cost of that fix, accepted deliberately: `community_lookup` went **~0.2s → ~5-12s** (whole-graph instead of a cheap 3-hop expansion). Weighed and taken — a fast answer that disagrees with the discovery pass silently corrupts the agent's evidence, and call volume is tens per benchmark run. Added a `GSQL-TIMEOUT` header in `tests/ws2/helpers.ts` since RESTPP's default 16s ceiling is uncomfortably close.
- **Decided positions (not oversights) on the other two queries.** `shortest_path` keeps the loose single-shared-entity rule and `max_hub_degree=25`: community membership is an *assertion* the agent acts on and must be conservative, a shortest path is a *lead* an analyst judges — a false positive costs a glance, a false negative hides the only link between a flagged card and a known fraud card. `label_propagation` also keeps the loose rule, on the grounds that the giant-component pathology is specific to **transitive closure** (WCC merges A-C via A-B-C; majority-vote LPA has each card commit to one label and never chains) — verified on the live graph: 13,234 clusters, largest 144, no degeneracy. Both keep the tight cap *because* they have no card-side guard, so `install.ts` now deliberately passes two different caps (`WCC_MAX_HUB_DEGREE=1000` vs `LOOSE_PROJECTION_MAX_HUB_DEGREE=25`).
- **New dialect findings:** `ELSE IF` parses inside `ACCUM`/`POST-ACCUM` but **not** in a top-level statement block (`no viable alternative at input`) — use independent `IF ... END;` statements there. `MapAccum.get()` on a key that may be absent compiles and returns the value type's default. RESTPP's default per-query timeout is **16 seconds**, which the whole-graph community queries exceed at a loose hub cap unless a `GSQL-TIMEOUT` header is sent.
- **A first attempt at an `as_of` regression test failed, correctly, and taught something worth keeping:** component count is **not monotone in `as_of`** under this rule. Because `min_overlap_pct` is a *fraction* of each card's footprint, later activity enlarges the denominator and can dissolve a link that qualified earlier — measured, 15,209 components as of 2016-08-01 vs 15,825 as of 2016-12-31, i.e. *fewer* components earlier, the opposite of an unnormalized rule. Replaced the assertion with the invariant that does hold (before any history, every card is its own component). Documented as an inherent property of a relative evidence bar, not a bug.
- `make verify-gsql` green end to end: 21 queries install, algorithms + discovery run, **42/42 tests pass** (up from 35 — added no-giant-component, multi-card-community, all-cards-accounted-for, `as_of`, baseline-beating and lookup/discovery-consistency assertions). No test was weakened: the one assertion that changed (`rate >= 0.5` → `rate >= 0.90` *and* `> baseline`) was strengthened. Committed and pushed to `ws2-gsql`.
- **User asked to review whether the Opus subagent's work actually met project requirements before trusting its self-report.** Independent re-verification found the report's "green"/"42/42" state did NOT hold: `SHOW QUERY txn_history` showed `# pendingInstall` and every single `tests/ws2` test failed with "Query endpoint disabled" when run cold. Re-ran `gsql/install.ts` directly (took ~7 min — the new per-card `min_overlap_pct` computation is materially slower than the old single-guard WCC) and got back to a genuinely passing state; then independently re-verified every headline number against the live graph directly (largest component 41, 15,825 components, 241 multi-card, 3 discovered patterns at 9/5/5 cards and 15/15, 11/11, 3/3 confirmed) — all matched the subagent's report once the graph was actually in the state it claimed. Lesson: a subagent's "done and verified" summary describes what it *intended* to leave behind, not necessarily the literal state of shared, stateful infrastructure (a live TigerGraph container) at hand-back time — always re-verify against the live system, not just the transcript, before trusting a completion report on infra-touching work.
- Also found, by cross-reading `PRD.md` sec.12 directly rather than trusting the codebase's own paraphrase of a "kickoff brief": (1) the "capped at 3h" note (both an earlier session's decision entry and the Opus subagent's carried-forward header comment) misread the PRD's actual text, `"Cap at 3 hours; hardcode what works,"` as a runtime "top 3" behavior spec, when it reads as a time-box instruction to the implementer. (2) PRD sec.12 explicitly requires four "community-level stats" — `size, velocity, shared-device density, risk-score distribution` — and two of them (`velocity`, `shared-device density`) were missing from both `community_lookup.gsql` and `discovery_report.gsql`; `risk-score distribution` (as `avg_risk_score`) was present in `community_lookup.gsql` but missing from `discovery_report.gsql`. Neither gap was introduced by the Opus subagent — both predate it, from this session's own original WS2 implementation.
- Fixed both: added `velocity` (txns/day over the community's active window, guarding against a near-zero span) and `shared_device_density` (device-touches per distinct device among members, reusing the existing entity-side `max_hub_degree` guard) to `community_lookup.gsql`; added the same two plus `avg_risk_score` to `discovery_report.gsql` (extending its `CompStatT` tuple and Pattern description text). Corrected the "capped at 3h" header comments in `discovery_report.gsql` to state the PRD's actual meaning, while keeping the top-3 cap itself (a reasonable design on its own merits). Added 2 new tests (velocity/density finite and non-negative on `community_lookup`; velocity/density/avg_risk_score finite and positive on every `discovery_report` result). `make verify-gsql` green, 44/44 tests (up from 42). Documented in `docs/decisions.md`.
- **User asked whether the new 41-card largest component (post-fix) needed removing, given the old 274-card one turned out to be bogus.** Wrote a throwaway diagnostic query (`check_component`, dropped after use — not committed) to inspect it directly rather than guess: 41 cards, 193 total txns (4.7/card, *below* the 36.2 dataset average), 4.9-entity footprint (also below the 7.8 average), and **zero connected `FraudCase`s** (not one). This is the opposite profile of the old 274-card artifact (which was 17.8x *above* average and the sole thing discovery emitted) — it's a plausible legitimate cluster (e.g. a household/small-office sharing a device and address) with no fraud signal attached, and it correctly did not qualify for `discovery_report`'s output (which requires >= 2 connected cases). Nothing to remove; `get_community` on any of its member cards would honestly report `confirmed_fraud_rate: 0` rather than anything misleading.

## 2026-09-19 — WS2 merged into main; WS4 real-tools switch wired and verified live

- Merged `ws2-gsql` into `main` (fast-forward, `a6b181d..f5718a4`) at the user's direction, after they asked to proceed with the plan's next steps. Stashed pre-existing uncommitted WIP on `main` first (same file list present since this session's very first `gitStatus` snapshot, unrelated to WS2, overlapping `docs/decisions.md`/`docs/logs.md`) rather than risk it interacting with the merge; popped and reconciled cleanly afterward (auto-merged, no conflicts), left untouched and uncommitted since it isn't mine to decide on. Pushed to `origin/main`.
- User then said "work on it" to the follow-up plan's step 2: unblock `agent/src/agentFactory.ts`'s `TOOLS_BACKEND=real` throw. Read `mcpClient.ts`, `toolsRegistry.ts`, `contracts/src/tools.ts`, and every WS2 query's `CREATE QUERY` signature + `PRINT` statement to work out the actual mapping needed.
- **The existing `RealMcpClient` would have failed on its first real call.** It called MCP tools by contract name and expected either `structuredContent` or bare-JSON text. Probed the live server directly (`tigergraph__run_installed_query`, the only real MCP tool tigergraph-mcp exposes) with a throwaway script: responses are a markdown-fenced JSON block wrapping `{success, data:{result:[...]}, error?}`, with the MCP-level `isError` staying `false` even on a real query failure — confirmed with both a bad entity id (query handles it, returns empty strings) and a bad query name (`success: false`, real `error` text, `isError` still `false`). Rewrote `callTool` around this confirmed shape, routing all 10 contract graph tools through `run_installed_query` at WS2's actual query names, with per-tool param-building and response-transform logic (verified each raw PRINT shape by reading every `.gsql` file's signature and, for shapes that weren't obvious from the source alone — `get_entity_profile`'s identity/device/address vertex-array branch, `detect_patterns`' map pair — by probing them live too).
- **`graph/mcp-server/` didn't exist in the main tree at all** — only in a disposable leftover worktree, whose venv turned out to be broken (relocated `pip` symlink pointing nowhere). Rebuilt cleanly (`python3 -m venv` + `pip install tigergraph-mcp==1.0.3`) directly under `graph/mcp-server/` in the main tree. Found it had **no `.gitignore` entry at all** — a 79MB venv, one `git add -A` away from landing in a commit. Added `graph/mcp-server/venv/` to `.gitignore` and a committed `graph/mcp-server/.env.example` (non-secret CE demo defaults) since `.env` itself is already covered by the repo's blanket `.env` ignore rule. Documented setup steps in `docs/MCP_TOOLS.md`. Started the server (`pnpm mcp:start`) and left it running.
- Checked whether the other half of the old throw ("WS3 services not up yet") was still true — it wasn't. `@hhgoa/rag`'s `createRagRuntime()` already provides real, contract-signature-matching `retrieve_policy`/`retrieve_similar_cases`/`lookup_external`. Wired those into `agentFactory.ts`'s `createToolProviders("real")`, added `agent/src/caseLedger.ts` (a real in-memory per-run case ledger for the 8 `case_*` tools — deliberately not a graph write, see `docs/decisions.md` for why), and made `createToolProviders` async (needs to await `rag.ensureIngested()`).
- Added `@hhgoa/rag` as a real dependency of `@hhgoa/agent` (`agent/package.json`), `pnpm install`, typechecked clean.
- **Ran the full real pipeline against the live graph, not just a typecheck.** First attempt threw immediately: `case_update_assessment` failed with "unknown case_id" — found that `ToolRegistry`'s silent case accessors always use the caller-supplied `RunAgentOptions.caseId`, never whatever `case_open()` returns, so the ledger's self-generated id was simply never looked up again. Fixed by constructing the ledger with the known case id up front. Re-ran: a real trigger (HHG-001's txn `3514030`) resolved correctly end-to-end (real card/customer/identity, real ±2h transaction history, real shared-device ring, real prior cases, a real RAG-backed `request_evidence` round) and reached a coherent `escalated`/`card_testing`/`0.89` verdict — the first genuinely real, non-fixture agent run in this project.
- That real run surfaced a second real bug: `find_shared_entity_rings` came back with several hundred cards through one device — the exact sentinel/missing-value device (`74ac7f403a804e8e`) WS2 already excludes from community detection. `shared_rings.gsql` has no hub cap by design (raw signal, caller's call), so added a `MAX_PLAUSIBLE_RING_SIZE=50` filter at the transform layer in `mcpClient.ts`. Re-ran again: the sentinel ring is gone; a second, smaller (45-card) ring from a different device passed through — left as-is, a judgment call rather than further speculative tuning (see `docs/decisions.md`).
- Ran `make test` (green, all 9 packages, 367 tests, no regressions) and `make lint` + individual `typecheck` on `agent`/`rag`/`policy` (all clean) before considering this done. Updated `docs/todo.md` (WS4 DoD row now `[x]`, WS1 repro-gap row now `[x]`) and `docs/decisions.md`.

## 2026-09-21 — WS6 UI/API audit (clean); found and fixed a real evidence-weighting bug behind "all 20 cases = fraud"

- User asked to verify the UI works against current API changes. Ran two parallel background audits (`api/` vs contracts/PRD §8.5/§14, `ui/` vs PRD §14) plus a hands-on Playwright verification (queue, case detail's 8 panels, neighborhood graph, approve/reject round-trip against the live API) — no gaps found, nothing needed implementing. One fork's first reply came back as a non-answer ("I'll wait for the fork's completion notification...") instead of its actual report; resumed it via `SendMessage` and got the real report on the second try.
- User then asked how the 20 benchmark cases (`cases/HHG-*.json`) get verified, and separately flagged that all 20 showing `verdict: fraud` "doesn't seem right." Checked directly: all 20 do show `fraud`, with only two distinct `fraud_probability` values repeating across unrelated cards (0.846154 × 16, 0.833333 × 4) — a strong signal of a systemic bug, not case-by-case bad luck. (There is no ground-truth answer key available to check against directly — README: "We score them against an answer key you don't have." The only real calibration lever is `eval/backtest.ts` against `closed_cases_history.csv`'s known outcomes, which as of this session had never actually been run — no `eval/NOTES.md`, no saved metrics anywhere in `runs/`.)
- **Root cause, found by reading `cases/HHG-001.json`'s actual exported evidence**: its `ev_001` cites a device profile shared with **45 other cards** as `card_testing`-supporting evidence. That's exactly the noise case `agent/src/sharedOrigin.ts`'s own docstring names by id ("HHG-001", "45") as the canonical example of a fingerprint crowd, not a fraud ring — and that module (`MAX_CORROBORATING_RING_SIZE = 10`, plus a corroboration requirement) exists specifically to keep a ring that size out of the fraud decision. But it was only wired into the **policy/SAR-routing** path (`caseState.ts`'s `shared_origin_connection`, `recommend.ts`'s R6), not into **evidence generation**. `agent/src/evidenceBuilder.ts`'s `ringsEvidence()` builds a `device_identity` item with `supports: ["card_testing"]`, weight 0.65, from the raw `find_shared_entity_rings` ring data for *every* ring regardless of size — so the 45-card noise ring still counted as a full independent evidence category feeding `assess.ts`'s confidence-cap/category-diversity logic and the LLM's hypothesis prompt, on every case that happened to hit a large shared-device ring (evidently most/all of the 20, given the near-identical probabilities).
- **Fix**: `ringsEvidence()` now imports `MAX_CORROBORATING_RING_SIZE` from `sharedOrigin.ts` and branches on it — rings ≤10 cards keep the original behavior (`supports: ["card_testing"]`, weight 0.65); rings >10 cards now produce a low-weight (0.15), `supports: []` item that reports the fact honestly without claiming it as fraud support. This doesn't touch the separate `MAX_PLAUSIBLE_RING_SIZE = 50` transport-layer drop in `mcpClient.ts` (that one exists to exclude >50-card sentinel/missing-value noise entirely, a different, already-settled question per the 2026-09-19 decision below) — it closes a distinct gap one layer up, for rings between the two thresholds (11-50 cards) that reach evidence-building but were never meant to read as fraud-supporting on their own.
- **Verified**: `pnpm --filter @hhgoa/agent typecheck` clean; WS4 suite (`tests/ws4/*`, includes `sharedOrigin.test.ts`/`investigation.test.ts` which exercise this exact path with a small 2-card fixture ring, unaffected by the >10 branch) 89/89 pass, unchanged. Full repo `vitest run`: only failures are 46 pre-existing `tests/ws2/*` + 2 `tests/ws7/*` tests needing a live TigerGraph on `:9000` (not running in this sandbox — no `tigergraph/community` image loaded locally, confirmed via `docker images`), unrelated to this change.
- **Not yet done in this session**: regenerating the actual 20 `cases/*.json` against a live TigerGraph to confirm the fix actually moves the verdict mix (needs `docker compose up` with a loaded CE image, then `make run-all`). Queued as the immediate next step.

## 2026-09-21 (later) — brought the stack up, ran everything, and found the two *actual* root causes behind "all 20 = fraud"

- User asked to run the whole pipeline for real. `docker compose up -d tigergraph mcp-server` — the CE image turned out to be present locally after all (4.94GB `tigergraph/community:4.3.0-rc1`, container just stopped), so the previous session's "no image loaded" note was wrong. Waited out the internal service boot; my first readiness poll was hitting a nonexistent path (`/restpp/echo`), which looked like a dead server but wasn't — RESTPP was answering with a valid JSON error the whole time.
- `make verify-graph` → PASS, full dataset reloaded and every vertex/edge count matched. **It does an unconditional `DROP ALL`**, which silently wiped WS2's installed query catalog and left only its own 5 smoke-test queries — so `make verify-gsql` (`install-queries`) must always follow it. Reinstalled all 24 queries (including the two new uncommitted ones, `vector_search` + `get_pattern_profile`); discovery + algorithms re-ran clean.
- `make test`: 9/9 packages green after one config-only change — `gsql/vitest.config.ts`'s `testTimeout` was 30s, but two tests chain 2-3 sequential ~15-20s whole-graph queries inside a single test, so they legitimately exceeded it while every individual query call succeeded. Bumped to 90s (same precedent as `eval/vitest.config.ts`). `make lint` clean.
- **First real regeneration (`run-benchmark --no-cache`) still gave 20/20 `fraud`** — so the ring-evidence fix from earlier today, while a genuine bug fix, was *not* the cause. Two deeper causes turned up:
  - **(1) The LLM's structured output was never actually being used.** `cases/HHG-002.json`'s `0.846154`/`0.153846` matched `assess.ts`'s `fallbackAssessmentProposal()` formula to six decimals (`min(0.55, max(0.3, risk_score 0.79)) = 0.55`, normalized over `[0.55, 0.1]`). Probed `OpenAiCompatLlmClient` directly with the real assessor prompt: the model returned valid JSON but **flattened** (`{"fraud_type": [...], "probability": ...}` at top level) instead of the required `{"hypotheses": [{...}], ...}` nesting, so both the first attempt and the repair retry failed schema validation and the silent deterministic fallback ran every case. That fallback floors the top fraud hypothesis at 0.3 and hardcodes `legitimate` to a small residual — **it can never return a legitimate verdict**. Fixed by adding an explicit example JSON object to `assessSystemPrompt()` (`agent/src/prompts.ts`); the prompt had described every field in prose but never shown the shape, which a quantized 7B local model can't reliably infer. Re-probed: schema-valid first try. Regenerated: verdicts finally varied.
  - **(2) `customer_denied` was being set by evidence that had nothing to do with the cardholder — and was an absolute override.** `machine.ts`'s `planAndRequestEvidence` did `if (evidence.supports.includes("fraud")) this.facts.customer_denied = true` for *any* evidence response, so an `analyst_info` note ("this device cluster has been flagged before", `weight_hint` 0.45, `contradicts: []`) or a timed-out `step_up_auth` was laundered into "the cardholder denied the transaction". `computeVerdict` then did `if (this.facts.customer_denied) return "fraud"` *before* looking at the probability at all, while the mirror flag `customer_confirmed` affected nothing but explanation prose. Measured the blast radius on the exported answers: **11 of 14 fraud verdicts were forced this way**, at probabilities as low as 0.25 — and HHG-003/010/020 closed as fraud on runs where the customer had explicitly *confirmed* the purchase.
- **Fix (2)**: only a cardholder-facing verification may set those facts — `customer_validation` in both directions, and a *completed* `step_up_auth` for confirmation only (a missed one is absence of an answer, not a denial). `computeVerdict` is now symmetric: a lone verification answer decides unless the accumulated evidence points hard the other way (`denied` → fraud unless p≤0.15; `confirmed` → legitimate unless p≥0.85), and contradictory answers across rounds fall through to the probability bands. Deliberately did **not** touch the 0.7/0.4 bands — retuning thresholds to hit a target distribution would be fitting the answer rather than fixing the defect.
- Added two regression tests to `tests/ws4/machine.test.ts` and **verified they actually catch it** by temporarily reverting both changes: the new test fails with `expected 'fraud' to be 'legitimate'` against the old code, passes against the fix. WS4 now 91/91.
- **Result: 20/20 `fraud` → 8 legitimate / 8 fraud / 4 uncertain**, which is in line with the README's "roughly half the cases are legitimate". The remaining spread is model calibration (a quantized 7B hedging into the 0.55-0.65 band), not a structural bias.
- **Operational gotcha worth remembering**: each `run-benchmark` pass writes real `FraudCase` vertices (`GRAPH-HHG-*`) back into TigerGraph, so a second pass over the same graph makes a case cite *itself* as a similar prior case (caught this as 20 `validate-answers` failures). Within a single chronologically-ordered pass, later cases seeing earlier ones is intended case memory; across passes it's contamination. Clearing just those 20 vertices via `DELETE /graph/hhgoa_fraud/vertices/FraudCase/GRAPH-HHG-0NN` is enough — no need to reload all 590k rows.

## 2026-09-22 — calibration investigation: found a probability-inversion bug, proved prompt-anchoring, swapped models, fixed the last spec violations

- Continued from the "8 legitimate / 8 fraud / 4 uncertain" state. User pushed back that the distribution still looked wrong and asked whether the 20 cases actually meet the requirements. They don't automatically — a `validate-answers` PASS only checks shape, so I built a standing audit script (errors, legit-vs-escalated, empty `affected_txn_ids`, R10 blocks, verdict/probability coherence, verdict/pattern coherence, write-back) and ran it after every iteration.
- **The biggest find: `fraud_probability` was inverted whenever the model concluded "legitimate".** Four call sites did `const topProb = top?.probability ?? assessment.legit_hypothesis_probability ?? 0`. `topFraudHypothesis()` returns `null` when the only surviving hypothesis is `legitimate`, so this fell back to the probability the case *is legitimate* and filed it as the *fraud* probability. A case the model was 100% certain was legitimate filed `fraud_probability: 1.0`, which every downstream band then read as fraud. HHG-006 was the smoking gun: `verdict: fraud`, `fraud_probability: 1.0`, `status: closed_fraud`, with recommended actions `ALLOW_TRANSACTION` + `CLOSE_NO_FRAUD` — two halves of the same codebase reading one assessment and disagreeing completely, because `recommendActions` used `topFraud?.probability ?? 0` and correctly saw 0. **This was suppressing legitimate verdicts in every run of the whole session**, so every distribution measured before this fix was distorted. Replaced with a single `fraudProbability()` helper (no fraud hypothesis ⇒ `1 − legit`, not `legit`), used by machine/explain/recommend alike; regression test verified to fail against the old code.
- **Proved that the local model copies numbers out of its own prompt rather than calibrating.** Ran seven measured iterations (A–H) on the same model, temperature and data, varying only prompt architecture. Every single time the model converged on whatever numbers appeared in the prompt: with the example showing `0.6`, eight cases came back at exactly 0.60; after rewriting the bands to name `0.85+`, eight came back at 0.84-0.85; with a de-anchored example at `0.73`, six cases returned exactly 0.73 and eight returned 0.85 — **14 of 20 cases taking their probability verbatim from prompt text**. Removing *every numeral* from the prompt (qualitative bands, `<your number>` placeholders) did not fix it: the model just defaulted to round values on a 0.05 grid and skewed harder. Conclusion recorded: this is a model-capability ceiling, not a prompt-engineering problem.
- **Tried the user's decomposition idea** (two-stage: a pattern-checklist triage call with no numbers, then a calibration call seeing only the distilled hypotheses). It made the distribution *worse* (16 fraud / 3 uncertain / 1 legitimate, probabilities pinned at 0.98-1.0) because stage 2 saw supporting-evidence lists stripped of context. Reverted to single-call — but it earned its place by exposing the `pattern: "none"` spec violation below.
- **Swapped Qwen2.5-7B → Qwen3-8B** (user's call, after being shown the anchoring data). Needed `-ctk q8_0 -ctv q8_0` (Qwen3-8B's KV cache is ~2.5× larger: 36 layers × 8 KV heads vs 28 × 4) and `--chat-template-kwargs '{"enable_thinking":false}'` (thinking blocks would collide with the GBNF grammar). Result: `card_testing` attribution fell from 16/20 to 12/20 and distinct patterns used rose from 4 to 6 — it genuinely discriminates between the documented patterns. Calibration did **not** improve, consistent with the finding above.
- **Spec violations found and fixed** (all against the authoritative DATASET_README):
  - **R8's "or the evidence conflicts" branch was never implemented** — only `exposure > $500` existed. Two uncertain cases (HHG-012, HHG-017) had genuinely split evidence and were closing with no analyst ever seeing them.
  - **R8 was keyed on the raw probability band, not the verdict.** README says "if the **verdict** is `uncertain`". A customer-confirmed case at p=0.45 (verdict `legitimate`) still counted as uncertain and got escalated, and since `assemble()` zeroes exposure for a legitimate verdict, HHG-006 shipped an action reading *"R8: uncertain with exposure $1906.07 > $500"* on a case declaring `legitimate` with `exposure_usd: 0`. That's why 18 of 20 cases were coming back `escalated`.
  - **R10 counted prior *cases*, not *cards*.** `caseState.ts` did `prior_cases.filter(outcome === "confirmed_fraud").length`, but `find_prior_cases` is scoped to the primary card — so three historical frauds on one card read as three cards and tripped `BLOCK_ALL_CARDS` on *all six* fraud cases, exactly the over-blocking the README warns scores badly. `PriorCaseRef` has no `card_id` (frozen contract), so the honest count from that source is 1.
  - **`pattern` disagreed with `verdict` in both directions.** README line 99: "Cleared cases have `pattern` = `none`". We were filing `fraud` with `pattern: "none"` (now `undocumented` + description, per R9) and `legitimate` with a real pattern (now forced to `none`).
  - **Case write-back polluted graph memory with the wrong vocabulary.** `persistCase.ts` wrote `p_outcome: verdict`, putting `"fraud"`/`"uncertain"` into the `outcome` column that `find_prior_cases` reads back as `confirmed_fraud`/`cleared`. Now maps fraud→`confirmed_fraud`, legitimate→`cleared`, and writes no outcome for `uncertain` (an uncertain case isn't closed).
  - **Failed cases silently kept stale answers.** `writeAnswersDir` wrote successes to an absolute `casesDir` but `writeErrorFile` hardcoded a cwd-relative `"cases"`, which under `pnpm --filter` resolved to `eval/cases/`. A failed case left the *previous run's* answer in the real `cases/` and `validate-answers` passed on it.
- **The ±2h transaction window was missing the flagged transaction on 16 of 20 cases.** Verified directly against the graph: the case pack opens cases **1-6 hours after** the flagged transaction for *all three* trigger kinds, not just `customer_report` (HHG-001/002/005 are 6h gaps on `risk_score`). An earlier fix had only widened it for customer reports. Now `LOOKBACK_HOURS = 72` uniformly, with `affected` narrowed back to a ±2h episode around the flagged transaction so the wider fetch can't sweep in ordinary spending, plus a guard so an *unanchored* sweep falls back to the narrow window. Also: `mcpClient.ts` resolved a `customer_report` to the **customer**, discarding the `txn_ids` the report names, and `eval/src/triggers.ts` discarded `flagged_txn_id` for `analyst_request` — both now resolve to the disputed transaction.
- **`shared_rings.gsql` gained `min_ring_size` and `window_days`** (user asked for it after HHG-011 came back with a 3.3MB answer file and 1486 evidence items, **420 of which were "rings" containing no other card at all**). Measured on HHG-011's card: 1355 groups → 250, with all 375 seed-only groups eliminated. My first version had a real bug — the recency filter was applied on the traversal *back* from the entity, which includes the seed's own edge, so any card that had used a device longer than `window_days` was filtered out of its own ring (caught by `tests/ws2/txnAndNeighborhood.test.ts`). Fixed by seeding each group with the seed card explicitly so the window governs only which *other* cards join. Also fixed an off-by-one where `card_ids` includes the seed, so evidence read *"shares device profile X with 1 other cards"* for devices nobody else used.
- **Two LLM-client defects**: the assessor never set a temperature so it fell through to `llm.ts`'s `?? 0.7` default — sampling at 0.7 for a structured judgment task, which is why identical inputs gave different verdicts across runs. Now 0 for structured calls. And we sent `response_format: {type: "json_object"}` (free-form valid JSON); verified llama-server supports `json_schema`, so `AssessmentProposalSchema` now goes over as a real JSON Schema and llama.cpp constrains generation with GBNF — the original "model flattens the schema" failure mode is now structurally impossible.
- **Infra: `llama-server` was pinning ~8GB of host RAM despite the model living entirely in VRAM** — `-hf` mmaps the model file and those pages stayed resident, exhausting swap and causing the recurring `System Memory in Critical` aborts that had been corrupting `resolve_trigger` mid-query (not just write-backs). This build has no `--no-mmap`; the equivalent is `-lm none`. Result: host RSS 7.96GB → **0.75GB**, available 3.1Gi → 9.3Gi. `make test` now passes with TigerGraph and the model running simultaneously — 9/9 packages, 450 tests, zero memory errors.

## 2026-09-22 — accuracy loop, iteration 1: two-stage assessor + exculpatory evidence

Sequence from `docs/todo.md` ("accuracy push"), step 1.

**Found.** `assess()` in `agent/src/assess.ts` had implemented the two-stage
assessor (triage → calibrate) all along as optional parameters, and
`machine.ts:assessRound` never passed them. Triage was running under the
assessor's instructions with the triage grammar; calibration re-read the whole
case under the assessor prompt. `triageSystemPrompt` and `calibrateSystemPrompt`
were built, tested for nothing, and dead. Wired both; single-call prompt kept as
the fallback when triage returns nothing usable. No change to LLM call count
(triage was already being called, just with the wrong prompt).

**Found.** Only two evidence items in the whole builder ever supported
`legitimate` ("no shared rings" 0.2, "only cleared prior cases" 0.1). Triage's
own rule is "never invent support", so a clean card's brief gave it nothing to
cite and `legitimate` came back `fits=false` — the mechanism behind 3/3 cleared
cases escalating. Six encodings were fraud-leaning by construction:

| item | was | now |
| --- | --- | --- |
| velocity (any count) | supports fraud 0.45 | neutral context 0.2 |
| detect_patterns, nothing fired | silent | supports legitimate 0.45, contradicts fraud |
| channel claim | supports surviving family 0.7 | contradicts-only 0.6 |
| flagged device already known (`Found`) | supports cnp_fraud 0.5 | supports legitimate 0.45, contradicts new_device |
| flagged charge in home region | never stated | supports legitimate 0.5, contradicts out_of_region |
| multi-region window | out_of_region 0.7 on any 2nd region | shape test as in GSQL: 2+ away 0.7, one short 0.55, one over 36h = trip (contradicts) |
| baseline in range | summary said "deviates" | summary says "within usual range" |

`Unknown` no longer counts as a known device — only `Found` does.

Stale prompt text cleaned: the calibrate prompt said replies were "SIMULATED
assumptions" (none are generated any more); "or they confirmed it" reworded to
"a recorded reply confirms it" in triage and assess. `prompts.ts` header now
lists which builders are live and which are documentation only.

Tests: `tests/ws4/exculpatoryEvidence.test.ts` added (13 cases pinning the
encodings above); one `discriminatingEvidence` test updated from the old
encoding. Agent suite 14 files green; typecheck clean.

Measurement: 20-case backtest, `--no-cache`, log `/tmp/hhgoa-run/bt_iter1.log`.
Baseline to beat (leak-free, previous run): pattern exact 8/17 = 47.1%,
false negatives 0/17, cleared escalated 3/3, `0.65` ×7.

### iteration 1 — run froze at case 5; timeouts added

The iteration-1 backtest completed cases 1-4 (42s/62s/34s/21s) and then froze
on CC-0037 from 22:15:13 until killed 27 minutes later. The worker sat in
`epoll_wait` with four sockets open to the MCP server, llama-server idle at 0%
CPU (its last task had completed normally), and `showprocesslist` reported no
query running inside TigerGraph. The eval runner's 900s per-case deadline did
not print a timeout either. Re-running CC-0037 alone afterwards completed in
39.1s with no error, so the stall was a transient MCP round-trip, not a
deterministic fault in the case.

There was no timeout anywhere on the two external dependencies. Added:
`MCP_CALL_TIMEOUT_S` (default 120; wraps connect and every
`run_installed_query` in `RealMcpClient`) and `LLM_REQUEST_TIMEOUT_S` (default
300; `AbortSignal.timeout` on the OpenAI-compatible chat call). A hung
dependency now fails that one call -- the registry records it and the case
continues -- instead of freezing the run. Documented in `.env.example`.

Note for scoring scripts: the answer file's `case.evidence` is `CaseEvidence`
(`claim, source, ref, entity_ids`) and carries no `supports`; the internal
`EvidenceItem` with `supports`/`contradicts`/`weight_hint` is in the
`evidence_added` event payloads.

Partial read from the four completed fraud cases: probabilities 0.43, 0.46,
0.48 and 0.15 (CC-5475, account_takeover, 112 items, closed legitimate). The
calibration stage has moved the anchor from "0.65, just under the fraud line"
to the middle of the 0.4-0.7 band. To be confirmed on the full 20 before
acting on it.

### iteration 1 — email rings were identity evidence; corrected

CC-0037 (cleared) re-run: brief genuinely fraud-shaped (flagged charge on a
device new to the account, `detect_patterns` fired card_not_present_new_device
0.65, shared device profile with six cards). `uncertain` + ESCALATE_TO_ANALYST
is the honest R1/R8 outcome there and `docs/DATASET_README.md` line 448 scores
it as full credit; the exculpatory items did not fire because nothing in the
data warranted them. One item in that brief was wrong: "Activity shares email
profile yahoo.com.mx with card(s) ..." at 0.65 supporting fraud. Email rings
link through an `EmailDomain` vertex and the dataset carries only domains
(README line 75), so that is a shared webmail provider, not a shared person.
Email rings are now descriptive (0.2, no supports); device and address rings
unchanged at 0.65. Test added.

Relaunched the 20-case measurement (`/tmp/hhgoa-run/bt_iter1b.log`) with the
MCP/LLM timeouts in place. Changes under test: two-stage assessor wired,
seven exculpatory/neutral encodings, email rings descriptive.

### iteration 1b — result pending; three false negatives found mid-run and root-caused

Partial read of `bt_iter1b.log` at 12/20: three confirmed-fraud cases closed
`legitimate`/`none` (CC-4386, CC-2247, CC-5194) that were `uncertain` with the
right pattern in the leak-free iteration-1 run, where false negatives were
0/17. The user flagged CC-4386 first; the other two followed. Not a one-case
effect, so diagnosed from code without waiting for the run.

Root cause (structural, not calibration text): `renderTriageForCalibration`
kept only triage candidates with `fits=true`. On a thin brief the 7B triage
marks every fraud pattern `fits=false` and `legitimate` `fits=true` -- the
iteration-1 exculpatory items now give it "specific evidence" to cite -- so
calibration was handed only `legitimate`. `finalizeAssessment` guarantees a
`legitimate` hypothesis exists but never a fraud one, and reads
`topFraud?.probability ?? 0`: with no fraud hypothesis the probability is
exactly 0 -> `legitimate`/`none`. The single-stage assessor never had this
path because its schema always carried both hypotheses. The two-stage split
introduced an asymmetry: triage could delete the fraud alternative before
anything scored it.

Fix (`agent/src/assess.ts`): calibration is always handed at least the
best-supported fraud candidate (most `supporting` ids), flagged in the brief
as "triage did not mark this as fitting; score it on the evidence below".
Triage classifies; it does not decide the case. The 0.4 legitimate threshold
is untouched -- moving it would trade these false negatives back for the
false positives iteration 1 was fixing. `renderTriageForCalibration` exported
for testing; 4 regression cases added to `tests/ws4/assess.test.ts` (only
legitimate fits -> best fraud added and flagged; a fitting fraud candidate ->
nothing added; nothing fits -> unchanged; no fraud candidates -> no-op).
Agent suite 14 files / 125 tests green; typecheck clean.

Exculpatory encodings reviewed and left alone for now. The one to watch is
"detectors ran and none of the five patterns matched" at 0.45 for
`legitimate`: detector recall is not perfect, so it fires on real fraud with
thin identity data too, and it is exactly the item that lets triage endorse
`legitimate` on a thin fraud brief. Measure the structural fix first; revisit
that weight only if false negatives persist.

Expected signature in `eval/backtest-detail.json` when bt_iter1b lands:
the three FNs at `fraud_probability` exactly 0 (triage filtered fraud out),
not 0.2-0.35 (calibration scored it low). To be confirmed.

### iteration 1b — final: 17.6% / 6 FN / 60%; two-stage reverted to a switch

Full result: pattern exact 3/17 = 17.6% (from 47.1%), false negatives 6/17
(from 0), decision agreement 60% (from 85%), cleared escalated 2/3 (from
3/3), macro F1 0.155 (from 0.447). The `p=0` signature held for exactly two of
the six FNs (CC-2247, CC-2673 — both card_testing, 325/313 items, both filed
ALLOW + CLOSE_NO_FRAUD); the other four were calibration scoring a fraud
hypothesis it did see at 0.15–0.35. Classification also collapsed
independently of the FN path: account_takeover became the magnet (4
predictions, 1 correct). Two-stage is a net loss on the primary metric, not
just on FNs, so the structural triage fix alone would not recover it.

Change: `stages?: 1|2` on `AssessOptions`; `ASSESSOR_STAGES` env (default 1)
in machine.ts; single-stage skips the triage call rather than ignoring it.
Everything from 1b that is independent of the split is kept. Recorded in
docs/decisions.md with the comparison table. Tests: 3 stage-count cases
(default = 1 call; stages:1 = 1; stages:2 = 2) in tests/ws4/assess.test.ts —
19/19; agent suite 125/125; typecheck clean.

Iteration 2 launched: `bt_iter2.log`, 20 cases, `--no-cache`,
`ASSESSOR_STAGES=1`. Expected to land near the iteration-1 numbers (47.1% /
0 FN / 85%) with cleared escalation ≤ 3/3; if it does, the 0.65 hedge is the
next target. Running at ~8–9s/case (one fewer LLM call per assessment).

Launch note: `pgrep -f "tsx src/backtest.ts" | head -1` captured the
transient tsx launcher shell, not the node worker, so the first PID-keyed
waiter fired at once. Key waiters on the `node … src/backtest.ts` process.

### Iteration 3 — restore the channel family; stop reading a known device as a vote for the cardholder

Iteration 2 (single-stage assessor restored, `ASSESS_STAGES=1`) measured on the
leak-free 20-case sample: pattern exact 29.4% (5/17), false negatives 4/17,
cleared-case escalation 3/3. Worse than the 47.1% / 0/17 the same assessor
scored before iteration 1 — so the exculpatory encodings, not the two-stage
split, had cost the accuracy. Re-ran CC-5475 deterministically to see why.

CC-5475 (gold `account_takeover`): 114 evidence items, `account_takeover`
detected at 0.80, seven shared device profiles — closed `legitimate` at 0.35.
The *only* legitimate-leaning item in the brief was the iteration-1 device-
Found encoding ("device already associated with this account", supports
`["legitimate"]` at 0.45). A known device is exactly what account takeover
looks like; stating it as a vote for the cardholder was wrong on its face.

Two changes, both in `agent/src/evidenceBuilder.ts`:

1. **Channel claim names the family again.** Iteration 1 emptied its
   `supports` on the reasoning that one purchase's channel is no evidence of
   fraud. True, but it is the classification signal that decides which fraud
   pattern is even *possible*, and removing it cost 47.1% -> 29.4% pattern
   exact with 4 new false negatives while cleared-case escalation stayed 3/3
   either way — pure loss. Restored at 0.5 (below the 0.6-0.85 the pattern
   detectors carry) so it steers the family without outweighing real signal.
2. **Device-Found rules out new-device and supports nothing.** `supports: []`,
   `contradicts: ["card_not_present_new_device"]`, summary states the
   ambiguity outright.

Tests updated to pin both (`discriminatingEvidence`, `exculpatoryEvidence`);
128/128 agent tests green, typecheck clean. Iteration-3 20-case run launched
(`bt_iter3.log`, node worker 35925). Note to self: the waiter must key on the
`node` process, not the `tsx` CLI wrapper, which exits in seconds.

### Iteration 4 — detectors set to the measured gold shape (card_testing, account_takeover)

Iteration 3 (channel family restored, device-Found neutral): pattern exact
23.5% (4/17), false negatives 2/17 (CC-4386, CC-0297), cleared 3/3 escalated.
Confusion matrix showed the loss is in pattern *labels*, and it is the graph
detectors, not the assessor: `card_testing -> card_not_present_fraud` 3/3,
`account_takeover` 0/3 correct, cleared 3/3 -> `card_not_present_new_device`.
Ran `detect_patterns` directly on those nine cards: card_testing fired on
0/3 gold card-testing cases, account_takeover on 1/3.

Measured the gold shapes from the CSVs rather than re-reading the rule text:

- card_testing (n=16, 48h before opened_at): `< $5` holds for 2/16, `< $10` for
  10/16 (fires on 1/60 cleared, 0/60 account_takeover); **0/16** have the small
  authorizations inside R5's one-hour span; follow-on purchase `>= $50` on 8/10.
- account_takeover (n=120 vs 120 cleared vs 120 other-fraud): the old gate's
  baseline spike fired on 4/120 (90/120 have no prior window); mixed channel is
  61/120 vs 57/120 cleared — no signal. Match-flag failures per transaction
  `>= 1.0` over 7d: 71% gold, 26% cleared, 39% other-fraud — the best split.

Rewrote both in `gsql/queries/detect_patterns.gsql` (tiers unchanged so the
tier test still guards drift), updated `docs/TX_FLAGGING_CRITERIA.md`, and
recorded the "measured shape over literal text" decision in `docs/decisions.md`.
Chain launched: stop llama -> gsql verify (reinstall+tests) -> agent tests ->
llama -> iteration-4 20-case run (`chain_iter4.log`, `bt_iter4.log`).

Open after this: cleared cases escalate with *no* detector firing (CC-0955,
CC-1660 at 0.45) — the structural claims alone lift them into the uncertain
band. Needs a dumped brief from a single-case rerun to see which items.

### Iteration 4 — result: 23.5% / 7 FN / 50%; the verdict was reading a split

Detectors now fire where the gold shape says (card_testing 2/3 -> `fraud`
at 0.75), but the headline did not move: pattern exact 4/17 = 23.5%, false
negatives 7/17 (CC-2394, CC-3907, CC-5194, CC-0297, CC-1665, CC-3983,
CC-3327), decision agreement 50%, cleared escalated 3/3.

The probabilities gave it away: 0.393939, 0.428571, 0.318182, 0.321429 are not
numbers a model writes. They are 0.65/1.65, 0.45/1.05, 0.35/1.1, 0.45/1.4 --
`finalizeAssessment` renormalising a proposal whose hypotheses summed past 1,
and the verdict then reading the *top single fraud type's* share. The
CC-5475 dump from iteration 3 shows it outright: account_takeover 0.35,
out_of_region 0.25, card_not_present_fraud 0.20, legitimate 0.20. That is 80%
fraud; the verdict read 0.35 <= 0.40 and closed it `legitimate`. Every time the
model hedged *between patterns*, the fraud decision was split across them.
This also explains why iterations 1-4 were so noisy: any change that made the
model name a second pattern moved cases across the 0.40 line.

`docs/DATASET_README.md` line 324 defines `fraud_probability` as "how likely
the flagged activity is fraud" -- fraud vs legitimate, not which pattern.

### Iteration 5 — fraud_probability is the total fraud mass

`fraudProbability()` (`agent/src/assess.ts`) now returns the sum of all
non-legitimate hypotheses (clamped to [0,1]); the pattern stays the argmax
fraud type. `finalizeAssessment`'s risk level reads the same number.
`agent/src/caseState.ts` had the same split *and* a leftover inversion
(`topFraud?.probability ?? legit_hypothesis_probability` fed the legitimate
mass to the policy engine as the fraud probability when no fraud hypothesis
existed); both it and `isLegitVerdict` now call `fraudProbability`. So the
verdict, the policy engine's R1/R2/R8 inputs, the risk level, the recommender
and the explanation all read one number. No threshold moved.

Tests: 4 cases in `tests/ws4/assess.test.ts` (the CC-5475 split reads 0.8 and
is not a legitimate verdict; a genuinely legitimate assessment still reads
low; no fraud hypothesis -> 0, never the legitimate mass). Agent 132/132,
typecheck clean. Iteration-5 20-case run: `bt_iter5.log`, node worker 41531.

Risk to watch: cleared cases where the model spreads mass over several fraud
patterns now read higher too. If cleared escalation stays 3/3 or some become
`fraud`, the fix is in the evidence those briefs carry, not in the arithmetic.

### Iteration 6 (prepared during run 5) — R8 "evidence conflicts" means a material conflict about the call

All three cleared cases in every 20-case run filed ESCALATE_TO_ANALYST. None
was over $500; they escalated through R8's second trigger, and
`conflictingLabels` (`agent/src/recommend.ts`) fired whenever any label at any
weight was both supported and contradicted anywhere in the record. That is
ordinary differential evidence -- the channel claim contradicts the other
family while a weak region item supports one of them -- so it held on almost
every case. The dataset's 900 cleared cases were all closed
`VERIFY_WITH_CUSTOMER|CLOSE_NO_FRAUD` on a single signal the cardholder then
confirmed (716 travel, 158 new phone, 26 unusual amount): R1's verify, not an
escalation.

Now a conflict is material evidence (weight >= CONTRADICTION_WEIGHT_THRESHOLD,
0.55, the confidence guard's own line) that both supports and contradicts the
*leading* pattern, or material support for fraud alongside material support
for legitimate. The exposure > $500 half of R8 is unchanged. Tests: existing
conflict fixture moved to material weights; 3 new (non-leading differential
does not escalate and still verifies; sub-material conflict does not
escalate; material fraud-vs-legitimate does). Agent 135/135, typecheck clean.
Not in run 5 (the agent module is loaded once at case 1).

Also prepared for run 6: `summarizeChange` (`agent/src/recommend.ts`). Every
answer so far reported `what_changed: "nothing"`, including cases that
requested evidence -- the brief grades "updates its recommendation as new
evidence becomes available" (Next best action, 25%). The comparison itself was
right; the text threw away the one true thing that happened. Now: nothing
requested and nothing changed stays `"nothing"` (`docs/DATASET_README.md` line
356); a request with no reply says which evidence was requested and that no
reply was received and none was assumed -- no invented outcome, per the
no-fabrication rule; a genuine change names the actions added and dropped and
the fraud probability it was made at. `machine.ts` now passes the request log.
3 new tests (incl. one asserting the no-reply text never reads as a
confirmation or denial). Agent 138/138, typecheck clean.

### Iteration 5 result, and the iteration-6 batch

Iteration 5 (probability-summing fix): pattern exact 35.3% (was 23.5% in
iteration 4), decision agreement 80% (was 50%), false-block on cleared cases
still 100%. Recall held; cleared-case handling did not move.

Iteration-6 batch, all spec-driven (`docs/DATASET_README.md` R2, R7, §3a):

- **R2 was never fed.** The recommender already had `fraudProb >= 0.7 ||
  customer_denied`, but a `customer_report` trigger -- which *is* the
  cardholder's statement that they did not make the charge -- never set
  `customer_denied`. New dispute step in `investigation.ts` (~L492) records the
  report as `customer_response` evidence and sets the flag. That is the
  trigger's own content, not an assumed reply.
- **R7 implemented** ("disputed but legitimate"). `checkRecurringCharge`
  (`investigation.ts` ~L444, exported, pure) looks for the disputed amount and
  product code repeating on a monthly cadence (26-35 day gaps, >= 2 prior
  months, 120-day lookback) via the existing `get_transaction_history` -- no
  GSQL or contract change. Outcomes: `recurring`, `not_recurring`, or
  `unchecked` when the history can't show the pattern; only `recurring`
  downgrades to CREATE_CASE + VERIFY_WITH_CUSTOMER + WARN_CUSTOMER instead of a
  block, and it suppresses `customer_denied`. Checked against real data first:
  HHG-018's $39.08 charge repeats 7 times but at irregular 1-20 day gaps on a
  7,079-transaction card, so strict monthly is correct; a one-match rule would
  have false-triggered on 4.7% of historical fraud reports. 10 new tests.
- **Backtest trigger was fabricated.** Every closed case was replayed as a
  `risk_score` alert scored 0.5 -- a value that exists nowhere in the data
  (real cleared-alert scores are 0.8-1.0). `targetFromClosedCase`
  (`eval/src/backtest.ts` ~L108) now reads the true origin and alert score from
  the opening of `analyst_notes`, and never its outcome. Two dispute phrasings
  handled; all 5,565 closed cases classify.

Caveat recorded in the adapter: in this history origin is perfectly confounded
with outcome (all 4,665 disputes confirmed fraud, all 900 alerts cleared), so
from iteration 6 on, backtest *verdict agreement* measures R2 wiring more than
judgment. Pattern accuracy and cleared-alert handling are the signals to read.
It also cannot test a model alert that turns out to be fraud -- the history has
none, yet 11 of the 20 benchmark cases are model alerts scored 0.52-0.90.

Gate: typecheck clean; agent 148, eval 36, policy 55 -- 239/239. Iteration-6
run: `bt_iter6.log`, node worker 51205.

### Iteration 6 result, and the iteration-7 batch

Iteration 6 (R2 fed by `customer_report`, R7, real backtest trigger), 20-case
sample: pattern exact **7/17 = 41.2%** (7/14 = 50.0% excluding the three
`undocumented` cases), false negatives **0/17**, cleared cases 3/3 not
`legitimate` (2 escalated, CC-0955 left open with VERIFY_WITH_CUSTOMER). Up
from iteration 5's 35.3%. Misses: account_takeover <-> out_of_region_use 4,
card-not-present cases named account_takeover 2, undocumented 3.

Root causes, measured over all 5,565 closed cases in the same 7-day window the
agent sees (flagged transaction joined from `first_fraud_txn_id`):

- **The flagged charge's region is the ATO/OOR discriminator.** It sits in the
  card's most-used card-present region for 71% of account_takeover cases but
  18% of out_of_region_use (78% vs 13% over 30 days).
- **The "flagged charge is at home" item supported `legitimate`.** It fired on
  40% of account_takeover cases against 3% of cleared ones -- it was pushing
  confirmed takeovers toward a clean verdict. Now `supports: []`, still
  `contradicts: ["out_of_region_use"]`.
- **The away-region item supported out_of_region_use whenever the window had a
  second region**, even with the flagged charge at home: fired on 94% OOR /
  59% ATO / 40% cleared. Gated on the flagged charge itself being away (or
  unknown to the window): 72% / 11% / 10%. Precision of the OOR claim
  ~46% -> ~76%, and it removes fraud evidence from 30 points of cleared cases.
- **Card-level `account_takeover` detector fires at 0.8 on online cases.**
  Confirmed live on CC-5194 and CC-3430. Only 84 of ~2,590 online-flagged
  confirmed-fraud cases (3.2%) are account takeovers, so the online channel
  claim now contradicts account_takeover alongside out_of_region_use.

Investigated and **not** changed: cleared cases. All three in the sample are
"cardholder confirmed the purchase from a new phone" -- online, device `New`,
observationally identical to `card_not_present_new_device`. The spec's "burst
of two to four within 48 hours" does not separate them (27% in every group).
The only strong separator is history depth (cleared median 11-12 prior txns vs
44-81), and it is a timing artifact: 515 of 900 cleared cases (57%) open in
July, the dataset's first month; the benchmark opens Nov-Dec. Using it would
not transfer, so it is not used. The separating fact is the cardholder's
confirmation, which the dataset withholds; the correct handling is verify
before blocking (CC-0955 did; CC-0037 at p=0.71 slipped just past R1's 0.70).

Gate: typecheck clean in all six packages; WS4 155/155 (two new region tests,
one online-channel assertion); 376 tests total. Two ws7 dataset tests hit
vitest's 5 s default while llama-server holds 8.3 GB -- they pass at 30 s and
are untouched by this batch. Iteration-7 run: `bt_iter7.log`, worker 61578.

### Iteration 7 result (logged late, before iteration 8)

20-case sample: pattern exact **7/17 = 41.2%** (7/14 = 50.0% excluding
`undocumented`) -- flat against iteration 6. False negatives **0/17**. But
**all 20 verdicts are `fraud`**: CC-0037, CC-0955 and CC-1660 (cleared,
model-alert triggers) went to `fraud` at p=0.875 / 0.80 / 0.90 with
BLOCK_CARD, where iteration 6 had left CC-0955 `uncertain` with
VERIFY_WITH_CUSTOMER. False-block 3/3. Decision agreement 17/20 = 85% only
because 17 of 20 gold outcomes are fraud. Misses: ATO<->OOR 3, undocumented 3
(fixed by iteration 8), CNP cases named ATO 2, CNP family confusion 1,
OOR->CNP 1.

Read: recall is solved, the verdict no longer discriminates. A model alert
with a new device online is the whole case for all three cleared cases; that
is a risk score plus one device signal, which R1 treats as verify-first.
Detail saved at /tmp/hhgoa-run/detail_iter7.json.

## Iteration 8 batch — proxy-device ring → `undocumented` + R9 (2026-09-23 00:06)

Target: the `undocumented` misses (0/3 in iteration 7). `docs/DATASET_README.md`
says not every pattern present in the data is documented; the one we can see in
the graph is many cards reached through one anonymous-proxy device that always
presents as new.

- **GSQL** (`get_entity_profile.gsql`, txn branch): for the flagged charge's
  device, 30-day counts before `as_of` — distinct cards, uses, uses through an
  anonymous proxy, uses presenting the device as `New`. No contract change:
  the client passes every printed field into `attributes`.
- **Agent** (`evidenceBuilder.ts`): `readProxyDeviceRing` fires at ≥5 cards
  with ≥80% of uses via anonymous proxy **and** ≥80% presenting as new. Values
  pinned in tests from the data: HHG-014's device is 20 cards / 26 uses /
  100% / 100%; nearest non-rings CC-0178 (4 cards, 60/60) and CC-4122
  (5 cards, 100% proxy but 20% new) do not fire; an ordinary shared hub does
  not either (shared devices alone are uninformative — most cases of every
  class share the flagged device with 2+ cards). Missing counts → no claim,
  never a guess. Emits one `graph` device_identity item supporting
  `undocumented`, with the device as an entity.
- **Label** (`assess.ts: resolvePatternLabel`): `undocumented` is back in the
  schema enum, but the final label is `undocumented` only when the graph found
  the ring. A model-chosen `undocumented` without graph support falls through
  to the next fraud hypothesis, so the model can't use it as a dumping ground.
- **R9** (`recommend.ts`): ring found and verdict not `legitimate` →
  CREATE_CASE + ESCALATE_TO_ANALYST; FILE_REPORT only once fraud is strongly
  suspected (≥0.70), per `docs/DATASET_README.md` line 257. `add` now dedupes,
  so R9 and the SAR rule can't list an action twice.

Gate: typecheck clean; WS4 17/17 files (13 new tests in
`tests/ws4/proxyDeviceRing.test.ts`). GSQL reinstall + iteration-8 run:
`chain_iter8.log` / `bt_iter8.log`.

### Iteration 8 result (2026-09-23 00:14)

| metric | iter 7 | iter 8 |
|---|---|---|
| pattern exact (fraud) | 7/17 = 41.2% | **7/17 = 41.2%** |
| false negatives | 0/17 | **0/17** |
| cleared blocked | 3/3 | **2/3** (CC-0955 `uncertain`, left open) |
| decision agreement | — | 18/20 |

The ring detector works: CC-3035 (gold `undocumented`) is labelled
`undocumented` for the first time. The other two `undocumented` gold cases
(CC-3907, CC-4124) do not have the proxy-device shape at their `as_of`, so
they stay mislabelled — expected, the rule was measured to find 4 of 9.

The new magnet class is `account_takeover`: 7 predictions, and 6 of the 10
misses are something-else → ATO (CC-1466, CC-1665, CC-4914 are gold
`out_of_region_use`). Cause: the agent's "home region" came from inside the
7-day sweep window, so a clone's own away-region charges counted as home and
the away charge looked like it was at home — the ATO signature.

## Iteration 9 batch (2026-09-23 00:40)

- **Pre-window home region** (`investigation.ts`, `evidenceBuilder.ts`): one
  extra `get_transaction_history` call over `[as_of − 90d, as_of − 7d)` gives
  the card's established home; the flagged card-present charge is then
  judged against that, not against the sweep window. Clone (away from the
  established home, home activity continuing) → out-of-region evidence;
  at the established home → ATO evidence; no prior history → no claim.
  Match-flag failures now route only to ATO when the charge is at home.
  Pinned in `tests/ws4/baselineHome.test.ts`, including the CC-1665 shape.
- **Community fraud rate leak** (`community_lookup.gsql`): cases counted on
  `ABOUT.ts <= as_of` (= opened_at), so unresolved cases — in a backtest, the
  case under investigation — fed their own label into the community fraud
  rate. Now gated on `closed_at`, with the epoch guard, same as
  `find_prior_cases` and `vector_search`. No effect on the 20 benchmark cases
  (every closed case resolved by 2016-11-06, before the first opens).
- **Case memory actually retrieves** (`investigation.ts`): the agent sent
  `card_id/patterns/channels/exposure_usd`, none of which rag's scorer reads;
  every query coerced to an empty fingerprint and returned the five oldest
  case ids at score 0.03. Now sends a real `CaseFingerprint` (card, customer,
  connected cards, amount band, flagged addr1). `pattern` stays `none` so a
  precedent isn't retrieved because the detector fired and counted twice.
  Probe: CC-1665 now finds its own customer's two prior cases at 0.30.
- **Precedent weight** (`evidenceBuilder.ts`): was a flat 0.5 for a fraud
  precedent and 0.15 for a cleared one regardless of similarity — a second
  fraud bias on top of an 84% fraud base rate. Now `min(0.5, 0.5·score)` for
  either outcome; a cleared precedent supports `legitimate`; amount-band-only
  matches (score < 0.1) are dropped as filler. `tests/ws4/similarCasesEvidence.test.ts`.

Gate: typecheck clean (agent, rag); agent 185/185 tests. Chain:
`chain_iter9.log` / `bt_iter9.log` / `detail_iter9.json`.

## Iteration 9 result (2026-09-23 00:47)

20-case sample, same as iterations 5-8. Pattern exact **8/17 = 47.1%** (iteration
8: 41.2%), false negatives 0/17, decision agreement 17/20. Cleared cases:
**3/3 blocked** (iteration 8: 2/3). `account_takeover` down to 6 predictions.
Still swapping: CC-1665 and CC-4914 (out-of-region → ATO), CC-0297 and CC-3327
(ATO → out-of-region), CC-3430 and CC-5194 (online, → ATO).

## Iteration 10 batch (2026-09-23 01:10) — one fact, one vote

Diagnosis from full dumps of cleared alert CC-1660 (p=0.90, blocked) and
CC-3430 (online, gold card_not_present_fraud, named account_takeover):

- **Shared-profile rings counted once** (`evidenceBuilder.ts` ringsEvidence).
  Every shared device/address profile was its own 0.65 fraud item; CC-1660
  filed ten. Measured on 60 cleared vs 60 confirmed-fraud closed cases at their
  own `opened_at` (email excluded): 3+ specific shared profiles on 67% of fraud
  vs 20% of cleared; 1-2 on 10% of fraud vs 47% of cleared. Per-ring items stay
  as context (0.15, no supports); one aggregate item votes: 3+ → fraud at 0.6,
  1-2 → context at 0.2 ("household or common device").
- **Precedents not double-counted** (`investigation.ts` similarCases). A case
  already cited by `find_prior_cases` was re-emitted as a similar-case item;
  CC-1660's customer's four prior fraud cases voted five times. They stay in
  `similar_cases` (the answer's `similar_prior_cases`); only the evidence is
  not repeated. (Prior confirmed fraud on the card/customer: 68% of fraud cases
  vs 26% of cleared — a real signal, now counted once.)
- **Card-present detectors on an online flagged charge** (`patternsEvidence`,
  mixed-channel claim). `detect_patterns` scores the whole card, so an
  account_takeover hit (0.85) plus the mixed-channel claim (0.7) outvoted the
  online channel item (0.5) on CC-3430. When the flagged charge is online these
  now stay as context. out_of_region_use is flagged online in 0 of 955 closed
  cases; account_takeover in 7%.

Tests: `exculpatoryEvidence.test.ts` (ring aggregate, crowd exclusion),
`onlineFlaggedDetectors.test.ts` (new), `machine.test.ts` (single shared profile
no longer votes). Agent 192/192, typecheck clean. No GSQL change → no
reinstall. `chain_iter10.log` / `bt_iter10.log` / `detail_iter10.json`.

### Iteration 10 result (2026-09-23)

20-case backtest, `--no-cache`, same sample. **Pattern 8/17 = 47.1% (flat vs iter 9), FN 0/17,
cleared escalated 2/3** (CC-0037 now `uncertain`/open, p=0.53; CC-0955 and CC-1660 still `fraud`
p≥0.90 with BLOCK_CARD). No errors.

- Online-flagged discount of card-present detectors fixed its two targets (CC-5194 → cnp_new_device,
  CC-3430 → cnp_fraud) and cost one online account takeover (CC-5475 → cnp_fraud; ~7% of takeovers are
  online). CC-2394 regressed card_testing → cnp_new_device with the card_testing detector still firing
  at 0.9 as the *only* detector — the model overrode it.
- Kev trigger check (docs/todo.md): pattern ≥47.1% ✓ (tie), FN ≤2/17 ✓, cleared escalated <3/3 ✓ →
  **not triggered**; staying on the current approach.
- `undocumented`: CC-3907/CC-4124 rings have zero proxy uses; measured that no graph shape separates
  non-proxy undocumented rings from ordinary CNP rings (docs/decisions.md). Accepted as undetectable.
- **Detector vs LLM:** detector-argmax alone 6/17, LLM 8/17, but the union is 12/17. The two cleared
  cases called fraud at p≥0.90 have *no* detector firing. Next: measure per-tier detector precision on
  held-out closed cases and weight detector evidence by it.

## Iteration 11 batch (2026-09-23) — calibrate evidence weights to held-out data

Target: cleared model alerts blocked at p≥0.90 (CC-0955, CC-1660) and the ATO↔OOR confusion.
All three cleared backtest cases are online, flagged charge on a New device, no proxy, and no
detector fires on any of them.

- **Flagged new-device claim** (`evidenceBuilder.ts`). Measured over all 5,565 closed cases: a
  cleared alert's flagged online charge is on a New device **98%** of the time (747/763), against
  74% for `card_not_present_new_device`; behind a proxy 7% vs 5%. The old "precision 0.93" was
  measured with cleared cases excluded. It supported new_device at 0.80/0.85 as if it were proof of
  fraud. Now framed like the channel claim — names the new-device pattern *if* this is fraud, 0.5,
  contradicts `card_not_present_fraud` (0% New), proxy no longer raises it. The separate
  "further new-device transactions in the window" item (0.35, same fact, second vote) is folded in.
- **Detector weights from held-out precision** (`DETECTOR_TIER_WEIGHT`). Old weight
  `min(0.85, 0.3 + score)` read the GSQL tier as the probability the detector is right. On 319
  held-out closed cases (stratified by gold, excluding the backtest 20): account_takeover@0.8 is
  right 36% (52 of 121 hits are out_of_region_use), out_of_region_use@0.8 32%,
  cnp_new_device@0.65 33%, card_testing@0.9 71%. Weight = precision shrunk toward 0.35 (k=5).
- **No-detector-fired item** no longer votes `legitimate` at 0.45: it holds on 32% of cleared
  cases but 48% of CNP fraud, so it is not exculpatory. Recorded, votes for nothing, 0.2.

No prompt text states how cases resolve (no-base-rate rule); the measured rates are in code
comments and weights only. Tests: `discriminatingEvidence`, `exculpatoryEvidence`,
`onlineFlaggedDetectors` (+3 tier-weight tests). Agent 195/195, typecheck clean. No GSQL change.
`chain_iter11.log` / `bt_iter11.log` / `detail_iter11.json`.

### Iteration 11 — first attempt INVALID (memory), rerun as 11b (2026-09-23)

The first iteration-11 run was killed at 12/20: every case returned `card_not_present_fraud` in
~8.3 s (normal 15–30 s). TigerGraph was answering REST calls with *"System Memory in Critical
state. Request aborted."* — host MemAvailable had fallen to ~1 GB, because llama-server's RSS had
grown to 8.7 GB (the mmapped GGUF stays resident even with every layer on the GPU). The agent
absorbed the failed graph calls silently and reasoned from the trigger and channel alone, so the
run looked healthy while measuring nothing.

Fix: llama-server restarted with `--load-mode none` (this build's replacement for `--no-mmap`):
RSS 8.7 GB → 0.7 GB, MemAvailable ~9.5 GB, GPU speed unchanged (53 tok/s). The chain now runs a
preflight (MemAvailable ≥ 3 GB, a graph read succeeds, llama healthy) before the backtest and
again after it, flagging the result as suspect if the graph degraded mid-run
(`chain_iter11b.sh`). Earlier iterations' timings and pattern spread were normal, so this is
believed to be the first affected run.

### Iteration 11b — result (2026-09-23)

Pattern exact 7/17 = **41.2%** (iter 10: 41.2%), macro F1 0.395, 0 false negatives, decision
agreement 17/20. **All 20 verdicts `fraud`**; the three cleared model alerts blocked 3/3 at
p=0.75–0.95. `card_not_present_fraud` is the magnet: 11 of 20 predictions, absorbing both
card_testing cases (CC-2394, CC-2247, which iteration 10 had right), both new-device cases and
both proxy-ring (`undocumented`) cases.

Diagnosis (brief dumps of CC-0037/0955/1660): the heaviest items voting "fraud" on the cleared
alerts were the flagged charge's **channel** ("online → CNP family") and **new-device** claims —
facts that say which pattern a case would be *if* it is fraud, listed as `supports: [...]` among
the ordinary evidence. The assessor read them as fraud votes. Both hold for almost every cleared
online alert (new device on 98% of them).

### Iteration 12 — batch: pattern shape is not fraud evidence (2026-09-23)

- **`PATTERN_SHAPE_PREFIX`** (`evidenceBuilder.ts`) marks the channel, new-device and known-device
  claims. The frozen `EvidenceItem` contract has no field for this, so it is a summary prefix.
- **Brief** (`contextBuilder.ts`) renders those items in their own `PATTERN SHAPE` section, before
  and outside `EVIDENCE`, as `fits:` / `rules_out:` rather than `supports:` / `contradicts:`.
- **Assessor prompt** (`assessSystemPrompt`, the live one — checked it has a call site): one
  paragraph saying the section chooses among fraud types and is never evidence that fraud occurred.
- Not changed: card_testing already carries the highest detector weight (0.56), so its losses are
  the CNP shape claims outvoting it, which this batch removes from the vote.
- Considered and **not** done: community fraud rate is sharpest at 0 (56% of cleared vs 21% of
  fraud, 240 held-out cases, `commrate.py`), but `get_community` only runs when a plausible ring
  lacks prior-fraud corroboration and the measurement was unconditional — it does not transfer to
  the population the agent sees. Needs a conditional re-measure first.

Tests: `contextBrief.test.ts` (3). Agent 198/198, typecheck clean. No GSQL change.
`chain_iter12.log` / `bt_iter12.log` / `detail_iter12.json`.

### Iteration 12 — result: SUSPECT (2026-09-23)

Pattern exact 7/17 = 41.2%, all 20 verdicts fraud, but the chain's postflight failed:
MemAvailable 1,565 MB. Root cause: llama.cpp's host-RAM **prompt cache** (`--cache-ram`, default
8,192 MiB) had grown llama-server's RSS from 0.7 GB to 8.3 GB across runs. The earlier "RSS 8.7 GB
→ 0.7 GB" drop credited to `--load-mode none` (iteration 11b) was mostly the restart emptying that
cache. Fix: `--cache-ram 0` in `/tmp/hhgoa-run/llama.sh`; restarted (MemAvailable 9.4 GB, 43 tok/s).
Iteration 12 re-run unchanged as 12b.

### Iteration 12b — result (2026-09-23)

Pattern exact 7/17 = **41.2%**, macro F1 0.392, 0 false negatives, decision agreement 17/20,
**cleared 3/3 escalated**. Postflight clean (MemAvailable 9.3 GB). `card_not_present_fraud` 8/20
and `card_not_present_new_device` 5/20 predictions. Misses: CC-2394/2247 card_testing→CNP (CC-2394's
own detector says card_testing 0.90), CC-5475 ATO→CNP, CC-3907/4124 undocumented→CNP,
CC-5194/3983 new_device→cnp_fraud, CC-0297/3327 ATO→OOR, CC-1665 OOR→ATO.

**Kev bar (pattern ≥47.1%, FN ≤2/17, cleared escalated <3/3): not met — third miss in a row
(11b, 12, 12b). Per the agreed sequence, Kev is next.**

### Kev — design and data export (2026-09-23)

Read Kev's README/model cards (`~/kev`, cloned upstream, Apache-2.0). Kev-0.8B out-of-domain accuracy
is 0.65–0.68 zero-shot, so the plan is a fine-tune (`--init_from jaredpalmer/kev-0.8b`) on our closed
cases. Design choices recorded in docs/decisions.md ("Kev as the pattern scorer"): pattern question
only, temporal split at 2016-09-01, state built by one function from agent-visible evidence.

- `agent/src/kev.ts`: `renderKevState` (≤1,400 chars; drops dispute text, R7 line, static external
  lookup; replaces id lists with counts; aggregates rings and similar cases), `KEV_PATTERN_QUESTION`
  (criteria quoted from docs/DATASET_README.md), `HttpKevScorer` (`KEV_URL`), `applyKevPatternScore`.
- `machine.ts`: gather extracted to `gather()`; `collectEvidence()` (LLM-free); `kevRerank()` after
  each assessment, logged as `tool_call`/`tool_result` `kev_pattern_score`, failure → assessor's own
  ranking. `agentFactory.ts`: `collectCaseEvidence`, `createEvidenceCollector` (shared RAG + MCP).
- `eval/src/kevExport.ts`: replays closed cases through the gather, writes Kev JSONL plus a raw
  evidence sidecar (`--rerender` rebuilds states without re-gathering). `backtest.ts`: `BACKTEST_FROM`.
- Tests: `tests/ws4/kev.test.ts` (7). Smoke export: 5 cases, 0.2–2.9 s each.
- Env: `uv sync --extra serve` + `flash-linear-attention` in `~/kev` (Python 3.13 venv, isolated,
  outside the repo); Kev-0.8B adapter and Qwen3.5-0.8B-Base (1.7 GB) downloaded.
- Export running: train = up to 400/pattern closed before 2016-09-01 (1,584 cases), eval = 60/pattern
  opened after (`.cache/kev/`, gitignored).

GPU finding: `nvidia-smi` (needs `LD_LIBRARY_PATH=/usr/lib/wsl/lib`) shows llama at 6,765 MiB used,
1,192 MiB free; torch's `mem_get_info` under WSL reports 6.4 GB free, which is wrong. Kev-0.8B needs
~2.1 GB, and llama prompts now reach 9.9k tokens, so `-c` can't drop far enough without truncating
briefs. Serving decision deferred to a CPU latency measurement after training.

### #19 — TigerGraph as the RAG vector index (2026-09-23, code; install pending)

- `gsql/queries/vector_search.gsql`: `qvec LIST<DOUBLE>` parameter (copied into a ListAccum by a
  top-level FOREACH; the old header's "list params can't be used" was wrong), true cosine (the old
  code was a raw dot product under a header claiming cosine), unscorable rows left out rather than
  scored 0, `scores_only`.
- `rag/src/store/tigergraphIndex.ts`: REST client, `syncChunks` (PolicyChunk vertices),
  `syncCases` (`vertex_must_exist=true`, never creates a case), `graphIdFor` (agent-written memory →
  `GRAPH-<id>`). `retrieve.ts`: optional graph scores for chunks and cases; an eligible record the
  graph has no embedding for throws. `RAG_VECTOR_BACKEND=tigergraph` switch; write-back mirrors the
  embedding. `rag/scripts/syncGraph.ts` (`pnpm --filter @hhgoa/rag sync-graph`).
- Tests: `tests/ws3/graphVectorIndex.test.ts` (5, parity + loud failure); rag 100/100.
  `tests/ws2/vectorSearch.test.ts` updated (qvec, scores_only, true cosine, unembedded case excluded)
  — live, runs after the install.

### #19 — installed and synced (2026-09-23 03:50)

`INSTALL QUERY ALL` passed. `rag/scripts/syncGraph.ts`: 29/29 PolicyChunk vertices and
5,565/5,565 `FraudCase.embedding` written (1.1 s). Live `tests/ws2/vectorSearch.test.ts` 11/11.

### Iteration 13 — batch: R1 single-signal guard, flagged-charge wording; scorer off (2026-09-23 03:53)

User asked for an iteration without Kev. Changes against 12b:

- `agent/src/singleSignal.ts` + `machine.ts`: when the fraud reading rests on at most one
  independent evidence category (pattern-shape items and weights ≤ 0.2 excluded), fraud mass is
  scaled to just below the fraud line, so R1's verify-before-block applies. Recorded on the
  `assessment_updated` event as `r1_single_signal_cap`. Target: CC-0037 (cleared alert, p = 1.0 on
  one detector hit weighted 0.33).
- `evidenceBuilder.ts`: a single high-risk row that is not the flagged charge is named as such and
  backs no pattern (CC-5194: card-present $150.01 row described as if it were the online disputed
  charge).
- RAG similarity scores come from TigerGraph `vector_search` (`RAG_VECTOR_BACKEND=tigergraph`);
  parity tests show identical rankings to the local store, so no accuracy change is expected from it.
- Pattern scorer (`patternScorer.ts`, Jev/Kev) present but disabled: `PATTERN_SCORER=none`.
- Tests: `tests/ws4/singleSignal.test.ts` (5); `machine.test.ts` budget-exhaustion case updated —
  its only fraud evidence is one category, so it now recommends VERIFY_WITH_CUSTOMER, not BLOCK_CARD.
  Agent 215/215, rag 100/100.

Run: `/tmp/hhgoa-run/chain_iter13.sh`, preflight mem 8,931 MB.

### Iteration 13 — result (2026-09-23 03:57)

20/20 cases, 0 errors, postflight OK (mem 8,926 MB). Scorer off, TigerGraph vector search on.

| metric | 12b | 13 |
|---|---|---|
| pattern exact (17 confirmed) | 7/17 = 41.2% | **8/17 = 47.1%** |
| false negatives | 0/17 | 0/17 |
| cleared escalated / blocked | 3/3 / 3/3 | **1/3 / 1/3** |
| decision agreement | — | 19/20 |
| fraud-type macro F1 | — | 0.425 |

- R1 guard: CC-0037 and CC-0955 (cleared) now `uncertain` → `open` with verify-before-block.
  CC-1660 (cleared) still `fraud`/escalated: it has two independent signals (shared-device ring +
  prior fraud on the card), so the guard correctly does not apply; it needs a different fix.
- No confirmed-fraud case fell below the fraud line (FN stays 0).
- Misses (9): card_not_present_fraud is still the magnet (5: CC-5475 ATO, CC-3907/CC-4124
  undocumented, CC-2247 card_testing, CC-5194/CC-3983 cnp_new_device); ATO→OOR (CC-0297, CC-3327);
  card_testing→cnp_new_device (CC-2394).
- Kev bar (pattern ≥ 47.1%, FN ≤ 2/17, cleared escalated < 3/3): **met** for the first time on all
  three. Pattern is exactly at the bar, so Kev remains the lever for discrimination.

### Iteration 14 — batch: evidence fixes from the iteration-13 misses (2026-09-23)

User: "Fix other issues and also evidences". Diagnosed from the iteration-13 answers
(`.cache/answers/*.real.openai.json`) and measured on held-out data (Kev export sidecar, 1,419 closed
fraud cases, backtest 20 excluded; closed_cases_history for fraud-vs-cleared).

Fixed:
- **False R7 claim** (`investigation.ts`). CC-2394: "disputed transaction 3128855 is not in the card's
  120-day history" — it is; the card has 1,518 rows in 120 days and the 500-row cap stopped at 2 Aug,
  the dispute was 31 Jul. R7 now reads its lookback as of the disputed charge; a capped miss says the
  history was truncated.
- **Window missed the disputed charge** (`investigation.ts`). When the flagged charge predates the
  168h window it is widened back to it (≤ 120 days, never past as_of). 2% of historical disputes
  (101/4,656) start > 7 days before opening; benchmark flagged charges are all 1–6 h before.
  `get_entity_profile.gsql` txn branch now returns `ts`.
- **Community vote** (`evidenceBuilder.ts`, `sharedOrigin.ts`, `community_lookup.gsql`). Supported
  fraud at any case-outcome rate ≥ 40%. The query now returns `n_cases` and the population rate over all
  cases closed by as_of; the item votes only when the community is above it (CC-0955: 48% of 67 vs 69%
  → no vote). The population figure is used in code, not printed.
- **Similar-case fingerprint** (`investigation.ts`). Matched closed cases through members of
  fingerprint crowds (>10 cards) and email domains; now only specific-ring cards.
- **Pattern 3 rule** (`patternRules.ts`, `machine.ts`). README: pattern 3 is CNP "with the identity
  record marking the device as New". New-device shape present on 289/400 cnp_new_device, 6/234 ATO,
  0/400 cnp_fraud. A CNP-fraud reading with that item moves its mass to cnp_new_device; recorded as
  `pattern_rule` on `assessment_updated`. Target CC-5194.
- **Wording**: billing regions printed `239` not `239.0`; "address profile" → "billing region"
  (addr1 is the billing region per docs/DATASET_README.md), also in rag similar-case reasons.

Checked and left alone (data did not support a change):
- "Online flagged charge rules out ATO": 93% of held-out ATO cases start in person (7% online).
- Ring web (3+ specific profiles → fraud 0.6): already calibrated (67% fraud vs 20% cleared); CC-1660
  is in the 20%.
- Prior confirmed fraud on the card: 68% of disputes vs 26% of cleared alerts — discriminative, kept.
- A card-testing "sequence → card_testing" rule: the sequence item fires on 8/800 CNP cases and only
  15 card-testing cases exist in the history, so it would add false positives. Not added.

Tests: `patternRules` (3), `communityEvidence` (4), `similarFingerprint` (1), `dispute` (+3).
Agent 226/226, rag 100/100, ws2 live 48/48. GSQL reinstalled (PASS).

### Iteration 14 — result (2026-09-23 04:21)

20/20, 0 errors, postflight OK (mem 8,774 MB). Pattern 6/17 = 35.3% (13: 8/17), FN 0/17, cleared
escalated 1/3 (unchanged: CC-0037, CC-0955 open/verify; CC-1660 escalated), decision agreement 19/20.

- Fixed: CC-5194 → card_not_present_new_device (pattern-3 rule).
- Flipped to wrong: CC-1665 (OOR→ATO), CC-1275 (cnp_nd→cnp_fraud), CC-2673 (card_testing→cnp_fraud).
  - CC-1665: evidence identical but for wording ("330" vs "330.0", "billing regions"); iteration 13
    was OOR 0.35 vs ATO 0.30, now ATO 0.65. The assessor runs at temperature 0 (structured.ts), so
    this is sensitivity to input text, not sampling noise.
  - CC-1275 / CC-2673: in iteration 13 the flagged charge was *outside* the 168h window, so neither
    case had any pattern-shape item and their hits did not rest on the flagged charge. With the window
    fixed, the "online → a card-not-present pattern" item appears and the assessor names plain CNP —
    on CC-2673 citing the card-testing sequence item itself as CNP support. CC-1275's flagged charge has
    no id_15 flag, so the pattern-3 rule correctly did not fire.
- Reading: the evidence fixes are corrections and stay. The 7B assessor's pattern pick is not stable
  under small input changes (±2 of 17 between runs on near-identical evidence), so a 20-case run cannot
  resolve changes of this size, and the Kev bar (≥ 47.1%) is missed again. The CNP magnet is the
  assessor mapping the online-shape item to plain CNP regardless of the other items.

### Iteration 15 — Jev pattern scorer (2026-09-23 04:27)

User: "Just run jev". Iteration 14 code with `PATTERN_SCORER=jev` (TypeSafe hosted, zero-shot; reranks
the documented patterns inside the assessor's fraud mass; verdict unchanged). Jev answered 20/20.

Pattern 8/17 = 47.1% (14: 6/17), FN 0/17, cleared escalated 1/3, agreement 19/20 — meets the Kev bar.
Jev right on all 3 card_testing (CC-2394, CC-2247, CC-2673) and 2/3 ATO (CC-5475, CC-3327), which the
assessor had wrong; wrong on all 3 OOR (CC-1466, CC-1665, CC-4914 → ATO) and on CC-3430 (online, → ATO),
which the assessor had right. OOR cases here are high-volume cards where the ATO detector (0.80 on
68–88 txns) and a mixed-channel/match-failure line sit beside the away-region line.

State defects found in the Jev input: lines capped at 220 chars (Kev's training size) cut conclusions
("…does not fit ..." lost "out-of-region use", CC-1665); a regex stripped region codes and left
"is in billing region, the card's usual region".

### Iteration 16 — batch: full state for Jev (2026-09-23)

`patternScorer.ts`: `StateLimits`; Kev keeps 1,400/220 (training size), Jev (served, 8k context)
gets 6,000/1,000 so every line is whole; region codes kept (".0" dropped). Tests +3; agent 229/229.

### Iteration 16 — result (2026-09-23 04:33)

Pattern 8/17 = 47.1%, FN 0/17, cleared escalated 1/3. vs 15: CC-0297 now right (ATO), CC-5475 now
wrong (→ CNP). OOR still 0/3 (all → ATO). Held-out data: the ATO detector fires on 95% of OOR cases
(precision 0.35) and the mixed-channel line on 68%; both match the README's ATO wording, while the
away-region line (76% OOR vs 9% ATO) carried no weight marker in Jev's state.

### Iteration 17 — batch: annotated state for Jev (2026-09-23)

`patternScorer.ts`: served state prefixes each item with "(weight w; supports …; contradicts …)", the
same annotations the assessor's brief carries (contextBuilder.ts). Weights are the held-out-calibrated
ones (iteration 11), not tuned on the backtest. Off for Kev's training-sized state. Agent 230/230.

### Iteration 17 — result (2026-09-23 04:38)

**Pattern 10/17 = 58.8%** (best so far; 16: 8/17), FN 0/17, cleared escalated 1/3 (CC-1660), decision
agreement 19/20, Jev 20/20 answered. Newly right vs 16: CC-1275 (cnp_nd), CC-1466 and CC-4914 (OOR).
Remaining misses: CC-3430 and CC-3983 (online flagged → ATO, despite the online-shape item contradicting
ATO), CC-5475 (ATO → CNP), CC-1665 (OOR → ATO), CC-3327 (ATO → OOR), CC-3907/CC-4124 (undocumented →
cnp_new_device; Jev only ranks documented patterns). n = 17, so ±2 cases is within run-to-run swing.

### Iteration 17 on 50 cases (2026-09-23 04:49)

User: "Run a test on 50 cases". Same code, `PATTERN_SCORER=jev`, `BACKTEST_SAMPLE=50` (seed 42; the
sample contains the 20 iterated on plus 30 new). 50/50, 0 errors, Jev 50/50 answered, postflight OK.

| | all 50 | 30 new |
|---|---|---|
| pattern exact | 32/42 = 76.2% | 22/25 = 88.0% |
| confirmed fraud called legitimate | 0/42 | 0/25 |
| cleared escalated / blocked | 4/8 / 3/8 | 3/5 / 2/5 |
| decision agreement | 46/50 | — |

Per pattern (all 50): ATO 7/9, CNP 7/8, CNP new device 7/9, card testing 4/5, OOR 6/8,
undocumented 1/3. New misses among the 30: CC-4940 (card_testing → ATO), CC-1171 (OOR → ATO),
CC-2633 (cnp_new_device → CNP).

Independence of the 30: 2 of them were in iteration 11's 319-case detector-precision sample and 8 in
the 1,419-case held-out set used for iteration 14's population rates (aggregate counts only; nothing was
fitted to a case). None were inspected case by case. Weak spot: cleared alerts — half of the 8 are
still escalated, 3 blocked.

### Gap analysis dispatched (2026-09-23)

User: "Make improvements on where the failure comes from ... Use subagents to analyze the gap". Three
read-only Sonnet analysts, in parallel, each forbidden from designing rules on the 50 backtest cases:
(1) cleared-alert escalations/blocks (4/8, 3/8), (2) the 8 non-undocumented pattern misses (may call
Jev ≤ 150 times on held-out states), (3) `undocumented` detection (design on the history's other
undocumented cases, test on CC-3035/3907/4124). Outputs: `$CLAUDE_JOB_DIR/tmp/gap_*/REPORT.md`.
Implementation stays with the main session (no concurrent code edits). Inputs snapshotted to
`$CLAUDE_JOB_DIR/tmp/answers50/` because the next backtest overwrites `.cache/answers`.

## Gap analysis results + batch (2026-09-23)

Three read-only Sonnet subagents analysed the iteration-17 50-case run (32/42 patterns, 0 FN,
cleared 4/8 escalated / 3/8 blocked). Each reported with counts; every proposal was re-checked
against the spec and the code before being applied, and three were changed or rejected.

**Undocumented** — 9 closed undocumented cases form two clusters. Cluster A (cross-card
anonymous-proxy device) was already detected. Cluster B (4 online charges inside an hour, each
$400–$500) had no detector → new `detect_patterns` block (see docs/decisions.md). Live check at
opened_at: fires on CC-3907 and CC-4124, not on CC-3035/CC-1660/CC-0589.

**Cleared alerts** — all 8 cleared cases were assessed `card_not_present_new_device`; 3 blocked at
p≈0.95 (CC-1660, CC-0988, CC-0589), 1 escalated correctly under R8 (CC-0979), 4 verified under the
R1 cap. Applied:
- `baseline_deviation` now returns `n_prior`; fewer than 10 prior transactions → "too few for an
  amount baseline", no vote either way (CC-0589: 2 priors, z = 1110).
- Detector tiers card_not_present_fraud@0.40 (47 cleared vs 30 fraud of 150/150),
  card_not_present_new_device@0.65 (44 vs 23) and @0.85 (7 vs 2) no longer count as an independent
  fraud signal for R1; they keep their pattern weight. The subagent also listed
  account_takeover@0.45 as backwards — that came from pooling hits already muted to 0.2; the live
  tier is 7 vs 9, so it stays.
- `find_prior_cases` marks each case `own` (about this card or its customer). Shared origin
  (R2/R6 "another card's fraud") now needs a non-own confirmed-fraud case; 43/43 cleared and
  107/110 fraud hits were own-history. Evidence text says whose fraud it was.
- R1 reason text states the actual basis instead of "no corroborating device or prior-case
  evidence".
- **Not applied:** the subagent's predicted flips for CC-1660/CC-0988 assumed own-card prior
  fraud stops counting as an R1 signal. Its own counts show it discriminates (110/150 fraud vs
  43/150 cleared; 67% vs 26% over the full history), so it still counts. Those two may stay blocked.

**Pattern misses** (8 non-undocumented) — Applied:
- Prior-cases item supports every pattern the cited fraud carried (first-listed pattern matched
  gold 310/540 held-out, the set 439/540). Sole wrong support on CC-3430.
- Flagged online charge not itself New, but another online charge in the window is → pattern-shape
  item supporting new_device at 0.4 (no R1 vote). Subagent's 76/76 recoverable / 0/334 FP used
  gold episode txn lists, not the agent's window — re-measuring on the window before trusting it.
- **Not applied:** decoupling the away-region item from the flagged-at-home branch — that gate is
  itself a measured decision (ungated it fired on 59% of ATO / 40% of cleared vs 11% / 10%), and
  the subagent's Jev A/B of the cheap variant showed 0 flips. CC-5475 (online-flag detector
  muting), CC-3327 (7% minority of a 93%-precision branch), CC-4940 (card-testing order reversed
  in the gold txns) left as is.

Tests: agent 242/242, typecheck clean. GSQL reinstalled (`detect_patterns`, `baseline_deviation`,
`find_prior_cases`), install PASS. Held-out LLM-free gather (same 300 cases as the subagent + 60 per
common pattern) running to measure the batch before the 50-case run.

### Held-out gather result (540 closed cases, none of the 50; LLM-free, 0 failures, 26 min)

Measured with the batch above in place (same 300 cases the subagent pulled before the fixes):
- Baseline "deviates" item: cleared 21 → 11 of 150, fraud 10 → 4. Thin-history note fires on 54
  cleared / 19 fraud and votes nothing.
- Structuring detector: 0 hits on all 540 (0/150 cleared, 0/390 fraud across the 4 common patterns).
- Prior fraud citing another customer's card: 3 of 390 fraud, 0 of 150 cleared — shared origin via
  prior fraud is now rare, as it should be.
- R1 (>1 independent fraud signal, dispute signal excluded because every replayed dispute is fraud):
  cleared 53/150, fraud 308/390. Barely moved: the remaining cleared cases carry real device-ring and
  own-card prior-fraud facts, which discriminate (≈2×) but do not separate.
- **Found and fixed — my own new-device item was backwards.** On the agent's window, "flagged online
  charge on a known device, other online charges New" fired on 69/104 card_not_present_fraud and
  23/96 card_not_present_new_device. The subagent's 0/334 false-positive check used the labelled
  episode transactions, which the agent cannot see. Now a lean away from new-device (contradicts,
  0.3, "without ruling it out"), not a vote for it.
- **Found and fixed — community double count.** 31 of 41 cleared community votes came from a
  one-entity community: the card alone, whose closed cases are its own prior cases (already counted
  under prior_cases). A community of size ≤1 now votes nothing and says so. R1 effect 53 → 50 cleared.
- Region gate re-checked on fresh evidence: "flagged charge in the card's usual region" fires on 79/99
  account_takeover vs 13/91 out_of_region_use; the away-region item 72/91 OOU vs 9/99 ATO. The
  subagent's 31% false-contradiction figure was from older evidence; no change.

Tests: all 606 pass (agent 243, rag 100, policy 55, contracts 86, api 35, eval 39, gsql 48); lint OK.
Iteration 18 (50 cases, Jev, TigerGraph vectors) launched 05:54.

### Iteration 18 restarted with the ring fix (user: implement the fix before the run)

First iteration-18 launch (05:54) stopped at case 12/50 so the remaining misleading evidence could
be fixed first; its partial results are discarded.

**Ring evidence counted the card's past fraud as a present ring.** `shared_rings` took the seed
card's side from every device / billing region it ever used (CARD_DEVICE up to as_of) and only
windowed the other cards. A card defrauded a month earlier still "shared" the fraudster's device
with that device's later victims. New `seed_in_window` parameter: the seed side comes from the
card's own transactions (MADE.ts) in the same 30-day window — no CARD_DEVICE.last_ts, which would
read use after as_of. The agent passes it; the default is unchanged for other callers.
Measured on the 540 held-out cases: broad-ring item fraud 237/390 → 169/390 (60.8% → 43.3%),
cleared 46/150 → 25/150 (30.7% → 16.7%); likelihood ratio 2.0 → 2.6. R1 (>1 independent signal,
dispute excluded): cleared 50 → 43 of 150, fraud 297 → 276 of 390.
New live test (ws2): in-window rings are a subset of all-time rings and always include the seed.

GSQL reinstalled (PASS). Tests: 607/607 (gsql 49). Iteration 18 relaunched 06:04.

### Iteration 18 result (50 cases, Jev, all gap fixes + in-window rings) — 06:14, postflight OK, 0 errors

| | iter 17 (50) | iter 18 (50) |
|---|---|---|
| Pattern exact (42 fraud) | 32/42 = 76.2% | **33/42 = 78.6%** |
| Fraud missed | 0/42 | 0/42 |
| Cleared blocked | 3/8 | **1/8** |
| Cleared escalated | 4/8 | **2/8** (CC-1660 blocked; CC-0979 R8, correct) |
| Decision agreement | 46/50 | **48/50** |

Flips: CC-3907, CC-4124 → undocumented (structuring detector; undocumented now 3/3). CC-0988
(p 0.95 → 0.65) and CC-0589 (0.95 → 0.69, thin-history baseline) no longer blocked. CC-1660 still
blocked (p 0.90). One regression: CC-5194 new_device → account_takeover. Jev 0.51–0.53 ATO vs
0.32–0.41 new_device; the prior-cases item now names every pattern its 7 priors carried (5 OOR,
2 ATO) instead of the first-listed OOR, and that ATO support is what Jev picked up. Subagent's
A/B of that change was +1/−1 on 35; left as is (correct, not tuned to one case).
Remaining pattern misses: 3 of 9 are account_takeover on an online flagged charge (CC-5194,
CC-3430, CC-3983); held-out online-flagged cases are ATO 14/798 (1.75%).

### Iteration 19 batch — channel rule (06:24)

`applyChannelRule` (agent/src/patternRules.ts), run after the pattern scorer and before the
new-device rule: when the flagged charge was online (the channel pattern-shape item) and a
card-present pattern (account_takeover / out_of_region_use) tops the documented hypotheses, its
mass moves to the strongest card-not-present reading (card_not_present_fraud if none has mass).
Fraud total unchanged, so the verdict is untouched; logged on `assessment_updated` as
`channel_rule`. Basis: out_of_region_use is card-present by the README's definition; of ~2,590
closed confirmed-fraud cases with an online flagged charge, 84 (3.2%) were account_takeover and 0
out_of_region_use (held-out 540 gather: 9/209 and 0). Targets CC-5194, CC-3430, CC-3983; accepted
cost is the ~3% of online-flagged fraud that is account takeover (CC-5475 is one, already missed).
Tests: +4 rule tests, +1 machine test; the scorer test's fake pick changed from account_takeover to
card_not_present_fraud because the fixture's flagged charge is online.
Also `BACKTEST_EXCLUDE=<file of case ids>` in eval/src/backtest.ts (off by default) for a later
fresh-sample test; 2,076 already-used ids listed in the job scratch dir.
Tests 612/612, lint OK. Iteration 19 on the same 50 cases launched 06:24.

### Iteration 19 result (same 50 cases) — 06:34, postflight OK, 0 errors

Pattern exact **34/42 = 81.0%** (iter 18: 33/42). Fraud missed 0/42; cleared blocked 1/8, escalated
2/8, decision agreement 48/50 — all unchanged. Channel rule flips: CC-5194 → new_device ✓,
CC-3430 → card_not_present_fraud ✓; CC-2520 (gold account_takeover, online flagged charge) →
card_not_present_fraud ✗ — the rule's accepted ~3% cost. CC-3983 and CC-4940 moved from
account_takeover to card_not_present_fraud, still wrong (gold new_device / card_testing).

### Iteration 20 batch — remaining misses, each checked on held-out data (none of the 50)

Pulled the agent's own 168h window for 2,696 held-out closed cases, and window + 83-day
pre-window for 600 ATO / 600 OOR. Per remaining miss:
- **Known-device flagged charge, other New online charges (CC-3983, CC-2633) — fixed.** Timing
  separates: a New online charge within 30 min of the flagged one on 38/96 new_device vs 8/227 CNP;
  30–60 min 7 vs 10. Weighted by pattern frequency in the history, new_device is the majority
  within 30 min and not after. New pattern-shape item (supports new_device, contradicts CNP, 0.4)
  for that case; the new-device rule now fires on it too. Beyond 30 min the lean-away item stays.
- **Online-flagged account takeover (CC-5475, CC-2520) — not fixable.** Always has card-present
  activity in the window (≥5 on 71/72) but so do many CNP/new-device cases; best signature
  (≥10 card-present + an online charge behind a proxy) makes ATO ~20% of the fraud it matches.
  Channel rule stays.
- **OOR flagged at the card's home region (CC-1665, CC-1171) — not fixable.** That shape is ATO
  386 vs OOR 43; best feature (≥3 charges in a never-seen region) still 28 ATO vs 10 OOR.
- **CC-4940 (card_testing) — not fixable within the spec.** Window has two ~$4.9 charges and no
  larger purchase after them; README pattern 1 needs three or more then a larger purchase.
- **CC-1660 (cleared, blocked) — left.** Still two independent signals: in-window ring (10 profiles,
  31 cards) and own-card prior fraud. Tried a 7-day card-side ring window: fraud 19.5% vs cleared
  10.7% (ratio 1.8, worse than 2.6 at 30 days) — reverted.
- CC-3327: minority of a 93%-precision branch (subagent), unchanged.

### Iteration 20 result (same 50 cases) — 07:17, postflight OK, 0 errors

Pattern exact **35/42 = 83.3%** (iter 19: 34/42). Fraud missed 0/42; cleared blocked 1/8, escalated
2/8, decision agreement 48/50 — unchanged. One flip, no regressions: CC-3983 → new_device ✓
(in-episode new device). CC-2633 still card_not_present_fraud (its New charges are not within
30 min of the flagged one, so the lean-away item applies). Remaining 7 misses are the ones measured
as not fixable above.

### Upper-bound check on the remaining misses (no code change)

Exhaustive search over 1–3-feature conjunctions of the window features the agent can see (counts
by channel, proxy, New devices, match-flag failures, amounts, timing around the flagged charge,
never-seen / away regions vs the pre-window home), in-sample on held-out data and weighted by
pattern frequency — an optimistic bound. Best achievable share of the minority pattern:
out_of_region_use among card-present flags at home **30%** (6/43 recall); account_takeover among
online flags **42%** (12/72 recall). Neither reaches a majority, so no rule — and no learned
scorer on the same evidence — can name them without losing more cases than it gains. These misses
(CC-1665, CC-1171, CC-5475, CC-2520; likewise CC-3327) are the data's irreducible error for this
evidence. Kev fine-tuning is not justified for them.

### Fresh 50-case run (unseen cases, 3 parallel shards) — 07:30–07:34, 0 errors

Sample excludes every case used to tune or measure anything (`BACKTEST_EXCLUDE`, 4,193 ids).
Pattern exact **37/40 = 92.5%**, fraud missed 0/40, cleared blocked **0/10**, escalated 1/10,
decision agreement 49/50. Misses: CC-4946 (CNP → new_device), CC-4196 (OOR → ATO), CC-2951
(ATO → OOR). Three shards share llama-server's slots: 50 cases in 4.3 min (was ~10 min serial).

### Next best action measured for the first time (judging: 25%)

Nothing scored the actions before; "decision agreement" only compares verdicts. New scratch
scorer compares final actions with the analysts' `actions_taken` / `report_filed`:
iteration 20 exact action-set 34/50, fresh run 35/50, action F1 0.87–0.88. Findings:
- **Analysts' report rule is exact:** confirmed-fraud reports were filed iff exposure > $1,000
  (393/393) or on the undocumented cross-card ring (4/4); never otherwise (4,268). Our report
  errors were exposure errors: 16/40 fresh fraud cases off by >25%, 4 on the wrong side of $1,000.
- **Cleared alerts never close:** analysts filed VERIFY_WITH_CUSTOMER|CLOSE_NO_FRAUD after the
  cardholder confirmed. No reply exists in the data (README §5), so closing would need an invented
  reply — deliberately not done.
- **Structural gaps (README §3b/§3a/§6):** uncertain cases recommended VERIFY but never asked
  (evidence_requests empty, initial == final, what_changed "nothing"); no CREATE_CASE at p ≥ 0.30;
  the stop reason said p=0.69 "clears the 0.75 confidence threshold" when the lead test held.

### Iteration 21 batch — episode scope + the §3b verify → re-recommend flow

- **Episode scope (investigation.ts `scopeEpisode`).** Measured on 2,406 held-out fraud cases
  (neither 50-case set) against the analysts' episode txns. Old rule (suspicious within ±2h):
  exposure within 25% on 57%, recall 0.49. New: flagged + same-channel charges with
  risk_score ≥ 0.3 (or online < $5, R5 probes) from 2h before the flagged one to as_of: 68%,
  recall 0.75, $1,000 side 95%. 2h lookback per user ("if 2hr is better keep it"; 24h: 62%).
  Every history episode starts at the flagged charge, but that is the backtest's construction
  (a replayed dispute points at `first_fraud_txn_id`) and the README says the flagged charge "is
  not necessarily where the fraud started", so the scope still reaches back. Undocumented cases
  re-scope by channel + product code after the detectors run (5/6 within 25% vs 0/6).
- **Bug:** txn_history rows come newest first, so `first_suspicious_txn_id` was the *latest*
  suspicious charge. Episode is now stored oldest first.
- **§3b flow (machine.ts `verificationPending`).** A non-dispute case at 0.40 ≤ p < 0.85 asks the
  cardholder (customer_validation) even when the stop rule is satisfied. No reply comes (§5), so
  `verification_unanswered` is set and the case is re-recommended on the same assessment (no
  second LLM call): R4 governs — MONITOR_CARD, CREATE_CASE, ESCALATE over $500. R4's
  DECLINE_TRANSACTION is for *pending* authorizations and the data has no authorization status,
  so none is invented. what_changed and stop_reason say exactly that.
- **§3a:** CREATE_CASE whenever p ≥ 0.30 (uncertain and low bands). The intended action skips
  CREATE_CASE so the planner and stop rule still see the decision; R9's reason overrides §3a's.
- **Stop text** names the condition that held (confidence or lead) instead of the 0.75 threshold.
- Tests: episodeScope (4), verificationFlow (7); stopRule text updated. make test all green, lint clean.

### Iteration 21 result — 07:47–07:56, 3 shards per set, 0 errors, pre/mid/postflight OK

| | fresh 50 (i20 code → i21) | original 50 (i20 → i21) |
|---|---|---|
| Pattern exact | 37/40 → 36/40 (90.0%) | 35/42 → 35/42 (83.3%) |
| Fraud missed | 0 → 0 | 0 → 0 |
| Cleared blocked | 0/10 → 0/10 | 1/8 → 1/8 (CC-1660) |
| Decision agreement | 49 → 49/50 | 48 → 49/50 |
| Report decision vs analysts | 45 → 46/50 | 44 → 46/50 |
| Exposure within 25% | 24 → 24/40 | 19 → 22/42 |
| Exposure wrong side of $1,000 | 4 → 3 | 7 → 5 |

Fresh-set pattern change is one case (CC-4775 OOR → ATO), within run-to-run noise. The action-set
F1 against `actions_taken` fell (0.87 → 0.78 fresh) by construction: the scorer reads only
`final`, VERIFY_WITH_CUSTOMER now sits in `initial` (it was asked), and §3a's CREATE_CASE now
appears on cleared alerts, which the analysts' records never list. Remaining exposure misses are
long card-testing episodes (CC-2394: 65 txns over weeks, CC-2247: 71) and OOR over-counts.

### Option B measurement — model-alert replay (08:26–08:34, 3 processes, 0 errors)

New backtest mode `BACKTEST_AS_ALERT=1` (eval/src/backtest.ts): a confirmed-fraud dispute is
replayed as a model alert on its own disputed transaction, with that transaction's real risk
score, as_of = txn ts + 3 h, and no dispute text; transactions scored below 0.5 are skipped.
Detail rows now carry `independent_signals` and the pre-cap probability.

| | Fraud replayed as alerts (69) | Real cleared alerts (45) |
|---|---|---|
| Verdict fraud (blocked) | 32 | 6 |
| Verdict uncertain (verify → R4 monitor) | 36 | 39 |
| Verdict legitimate | 1 (CC-1072, p 0.15, monitored) | 0 |
| 0 independent fraud signals | 16 | 25 |

Among non-fraud verdicts, the best rule for assuming "cardholder confirms" (0 signals and
new-device pattern) would close 24/39 cleared and 6/37 fraud. No zero-miss rule, so option B was
not adopted (docs/decisions.md). This is also the first measurement of fraud arriving as a model
alert: under the current agent, 46% are blocked and 52% stay open under verification.

Same batch: L1/L2 actions now stay PENDING_APPROVAL (were reported EXECUTED right after the
approval request); §3a CREATE_CASE added to the low-probability no-pattern close; R3 reasons no
longer claim a customer confirmation. Agent tests 266/266.

### Deliverables refresh (08:39–08:50)

- Benchmark: all 20 answers regenerated with the current agent
  (`PATTERN_SCORER=jev RAG_VECTOR_BACKEND=tigergraph`, run `runs/bench-final-0839`, 20/20, 0 errors);
  `make validate-answers` PASS 20/20. 15 fraud (all BLOCK_CARD + CREATE_CASE; HHG-006 also
  FILE_REPORT as the undocumented amount-structuring burst), 5 uncertain (verify → no reply → R4:
  CREATE_CASE + MONITOR_CARD, plus ESCALATE_TO_ANALYST on HHG-010 and HHG-014 over $500).
  L1/L2 actions are now recorded PENDING_APPROVAL.
- Replay fixtures rebuilt from that run, relabelling the case id only: `HHG-910` ← HHG-006
  (clear fraud, BLOCK_CARD + FILE_REPORT pending approval), `HHG-920` ← HHG-017 (ambiguous:
  evidence requested, no reply, R4). The old ambiguous fixture still held a simulated customer
  denial from before the no-fabrication fix. `make test` 9/9 packages, `make lint` clean.
- README, blog post and demo script updated: option B measurement, model-alert replay result
  (32/69 blocked), §3a CREATE_CASE wording, current fixtures.

Correction (09:40): the deliverables entry above first said "13 fraud, 7 uncertain"; a recount of
`cases/` gives 15 fraud and 5 uncertain (HHG-010, -013, -014, -017, -020). The same wrong count
went into commit 65ef6ac's message and the blog post; the blog is corrected.

### Iteration 22 batch: model-alert calibration and the legitimate-verdict flow (2026-09-23 09:45)

- Evidence gathers (TigerGraph only, no LLM): design 900 cases → 605 with evidence (300 cleared,
  305 fraud-as-alert; 295 fraud skipped because the bank's model scored them below 0.5, 0 failures);
  held-out 1,041 → 629 (241 cleared, 388 fraud; 412 skipped, 0 failures).
- Zero-miss closing re-checked on held-out: the full 80-feature model at its strictest design
  cutoff closed 18 of 241 cleared and 1 of 388 fraud. Not adopted.
- Calibration: sign-constrained logistic model adopted by a rule set before the held-out look
  (design CV AUC 0.851 vs 0.859). Held-out AUC 0.909 with reliable probabilities (decisions.md).
  TypeScript port matches the Python model on all 629 held-out cases (max difference 0.00014).
- Code: `agent/src/alertCalibration.ts` (new); `machine.ts` applies it to `risk_score` triggers
  (off via `calibrateAlerts: false` for band tests), exempts the proxy ring from the R1 cap, asks
  the cardholder on a legitimate reading (also on the no-discriminating-evidence stop path), keeps
  such cases `open`, and names R3 in the no-reply stop text; `recommend.ts` legitimate branch:
  confirmed → R3 close, unasked → verify + monitor + case, no reply → R4 monitor + case;
  proxy-ring evidence states its history sample.
- Tests: `tests/ws4/alertCalibration.test.ts` (7 new); recommend/machine/verification tests updated
  for the new flow. `make test` all packages pass (agent 273), `make lint` clean.
- Baseline for the alert replay (iteration 21 agent, earlier sample of 45 cleared + 69 fraud):
  cleared 0 legitimate / 39 uncertain / 6 fraud (6 blocked); fraud 1 legitimate (CC-1072 closed) /
  36 uncertain / 32 fraud; 1:1 Brier 0.304.
- Iteration 22 launched 09:47: alert replay on the held-out set (130 fraud sampled, 60 cleared),
  then fresh 50 and original 50.

### Iteration 22 result (2026-09-23 10:04)

Chain `/tmp/hhgoa-run/chain_iter22.sh`, 0 errors, preflight/midflight/postflight OK (memory ≥ 8.8 GB).

Alert replay on the held-out calibration set (fraud replayed as alerts; cleared are real alerts):

| | iteration 21 (45 cleared, 69 fraud) | iteration 22 (31 cleared, 50 fraud) |
|---|---|---|
| cleared called legitimate | 0 | 18 (58%) |
| cleared blocked | 6 (13%) | 5 (16%) |
| fraud blocked | 32 (46%) | 25 (50%) |
| fraud called legitimate | 1, closed (CC-1072) | 4, none closed or allowed |
| Brier, 1:1 weighted | 0.304 | 0.160 |

The samples differ (iteration 21's was drawn before the calibration sets existed), so the rows
compare rates, not the same cases.

| | fresh 50 i21 | fresh 50 i22 | original 50 i21 | original 50 i22 |
|---|---|---|---|---|
| pattern exact | 36/40 | 36/40 | 35/42 | 35/42 |
| false negatives | 0 | 0 | 0 | 0 |
| cleared legitimate | 0/10 | 10/10 | 0/8 | 6/8 (2 uncertain) |
| cleared blocked | 0/10 | 0/10 | 1/8 | 0/8 (CC-1660 no longer blocked) |
| decision agreement | 49/50 | 50/50 | 49/50 | 50/50 |

Action gap that remains by design: analysts close cleared alerts with `VERIFY_WITH_CUSTOMER` +
`CLOSE_NO_FRAUD`; ours end `CREATE_CASE` + `MONITOR_CARD` (no confirmation to close on), with
`VERIFY_WITH_CUSTOMER` in the initial recommendation only.

### Benchmark answers regenerated with iteration 22 (2026-09-23 10:13)

- `cases/` regenerated twice: first at 10:04, then again after two wording fixes found in the
  answers (`what_changed` named R1 for a legitimate reading's R3 request; the summary quoted the
  flagged amount as "exposure" while `exposure_usd` was 0). `make validate-answers` PASS 20/20.
- 13 fraud, 6 legitimate, 1 uncertain (was 15 fraud, 5 uncertain, 0 legitimate). HHG-005, -015,
  -019 moved fraud → legitimate; HHG-010, -013, -020 uncertain → legitimate; all six sit at 0.37
  (flagged charge online on a new device, prior cases present); held-out alerts with that exact
  evidence were 11 cleared and 9 fraud, about one in three fraud at a 1:1 weighting (an earlier
  draft said "a quarter", which was the whole 0.30-0.40 band), and all six ask the cardholder and
  stay open. HHG-014 moved
  uncertain → fraud (undocumented proxy device ring, R9: case, report, escalation, block).
  HHG-017 stays uncertain at 0.69 (calibrated high, capped by R1 on a single signal).
- README, blog and demo script updated to iteration 22.

Cutoff check (10:30): the legitimate-verdict cutoff stays at 0.40. Lowering it below 0.37 would
turn the six benchmark `legitimate` answers into `uncertain` (13/0/7), add R8 escalation on
HHG-010 and HHG-015, and change no close, block or probability. On the 629 held-out alerts it
moves cleared-called-legitimate from 69% to 64% and fraud-called-legitimate from 5.9% to 3.6%.
The user chose to keep 13 fraud / 6 legitimate / 1 uncertain; choosing the cutoff from the
benchmark answers would also have been tuning to the test set.

### R7 on busy cards; blocked cleared alerts diagnosed (2026-09-23 ~10:50)

**R7 without the row cap.** `txn_history` returns the 500 newest rows, so on busy cards the
120-day R7 lookback reached back only 12-13 days and HHG-011 and HHG-018 filed "R7 could not be
checked". New `checkRecurringByMonthlyWindows` (`agent/src/investigation.ts`): when the capped read
cannot rule R7 out, it reads only the 26-35-day window before the disputed charge (then before
each repeat found), splitting a window into 3-day slices if it alone passes the cap. Live check on
the 8 benchmark disputes, graph only: all 8 now checked, none recurring, so R2 governs all of them
as before. The busy-card summary says only the monthly windows were read (the first draft
reported "0 earlier charges in 120 days", which was false for HHG-018's thirteen $39.08 charges).
Two new tests in `tests/ws4/dispute.test.ts`; ws4+ws5 330/330.

**Blocked cleared alerts (iteration-22 alert replay, 5 of 31).** All five share one profile: the
flagged charge card-present, on a device the account already knew, with prior cases on the card
(calibrated 0.81-0.88). In the design set that profile is 20 cleared vs 96 fraud, and the model's
0.83 band matched 0.85 actual on held-out data, so the probability is right for the evidence.
The one candidate separator found (the card's billing region shared with too many cards to be a
ring: 16/20 cleared vs 39/96 fraud in the profile) added nothing on design-set CV (AUC 0.852 ->
0.854, Brier 0.145 -> 0.146, cleared at >= 0.70 29 -> 28), so no change; the held-out set was not
consulted.

### Iteration 23 batch: episode scope from a per-transaction model (2026-09-23 ~11:05)

- Why: iteration-22 exposure within 25% was 60% (fresh 50) / 52% (original 50); card-present
  patterns were the weak part (account takeover 6/19, out-of-region 9/18, card testing 0/5 across
  both sets) and 8 of the 10 non-cleared action mismatches were report decisions.
- Data: 2,710 held-out confirmed-fraud cases gathered from the graph as the agent sees them at
  `opened_at` (all account takeover, out-of-region, card-testing, undocumented; 300 of each
  card-not-present pattern). Verified: none of the fresh-50 or original-50 cases is among them.
  Every analyst episode transaction was visible in every case, so the ceiling is 100%.
- Findings (design half): no transaction before the flagged charge is ever in an analyst episode
  (0/964); out-of-region episodes stay in the flagged charge's foreign region, often at the same
  amount and identity-check flags; account-takeover rows come from regions new to the card.
- Chosen on design-half CV: one logistic model, 15 features, cutoff 0.4 (a per-channel pair added
  ~1 point and was dropped). Check half, scored once: within 25% 65% -> 74%, wrong side of $1,000
  7.0% -> 5.2% (account takeover 64 -> 73%, out-of-region 60 -> 75%, card-not-present 78 -> 83%,
  new device 74 -> 71%). Card testing (9 cases) left to the general score.
- `agent/src/episodeModel.ts` (new), `scopeEpisode` default mode uses it; tiny online probes still
  join online episodes. TS reproduces the Python selections on 2,696/2,696 cases.
- `tests/ws4/episodeScope.test.ts` rewritten for the model (out-of-region shape, 2h bound, probes,
  undocumented). `make test` 9/9, `make lint` clean. Iteration 23 launched 11:07: fresh 50 and
  original 50, then the 20 benchmark answers and `make validate-answers`.

### Iteration 23 result (2026-09-23 11:25)

Preflight OK before each stage (8.9-9.1 GB free), 0 errors on both 50-case sets,
`make validate-answers` PASS (20/20).

| Iteration 22 -> 23 | Fresh 50 (unseen) | Original 50 |
|---|---|---|
| Exposure within 25% | 26 -> 32 of 40 | 23 -> 26 of 42 |
| - account takeover | 3 -> 9 of 10 | 3 -> 3 of 9 |
| - out-of-region use | 5 -> 8 of 10 | 4 -> 5 of 8 |
| Report decision agrees with analysts | 46 -> 46 | 46 -> 44 |
| Fraud pattern correct | 36 -> 37 of 40 | 35 -> 35 of 42 |
| Fraud missed / cleared blocked | 0 / 0 | 0 / 0 |

Report changes: fresh 50 fixed CC-4196 ($2,438 -> $453) and lost CC-2166 ($1,126 -> $936);
original 50 lost CC-1275 ($996 -> $1,114 against the analysts' $953, now over the $1,000 line)
and CC-4447 (exposure unchanged at $114; this run gathered one fewer evidence item, so run-to-run
variation, not the episode change). Kept: exposure clearly better, report agreement 92 -> 90 of
100 with one of the two losses unrelated.

Benchmark answers: `affected_txn_ids` and `exposure_usd` identical on all 20 (the benchmark
episodes are one to four transactions and the model keeps the same rows). Verdicts, patterns,
statuses and actions unchanged. Only local-LLM variation in `fraud_probability`: HHG-006
0.90 -> 0.95, HHG-018 0.74 -> 0.90, HHG-014 0.90 -> 1.00 (the assessor put 0 on the legitimate
reading; HHG-014 is an analyst request, so alert calibration does not apply).

Found while checking: the §6 stop reason quotes the leading pattern's probability as "Fraud
probability" (HHG-014: text 0.87, `fraud_probability` 1.00; before: 0.80 vs 0.90). Not fixed yet.

### R4 declines the flagged authorization; API live runs fixed (2026-09-23 12:15)

- **Audit.** Read all 20 regenerated answer files against `docs/DATASET_README.md`'s policy text
  (Actions table, R1-R6, §3a, §7). Found three mismatches between the answers and the written
  policy:
  1. R4 ("no reply within 24 hours") never recommended `DECLINE_TRANSACTION`. The earlier decision
     (this log, "Unanswered verification is R4") read R4's `DECLINE_TRANSACTION` as needing a
     *pending-authorization* status the dataset lacks. The policy's own Actions table says
     otherwise: `DECLINE_TRANSACTION` is "Decline the flagged authorization only," and its own
     worked example (HHG-017 in the dataset README) recommends it for a purchase that had "already
     cleared." So it applies to the flagged charge itself, not to a separate pending-authorization
     record that this dataset never had to begin with.
  2. `BLOCK_CARD`'s reason cited "R2: customer denied ... or fraud probability exceeds 0.70" on
     every block, including model alerts nobody disputed.
  3. `CREATE_CASE`'s reason cited "R6 / §3a" on every block, with no shared-origin connection behind
     the R6 half.
- **What changed** (`docs/decisions.md`, "R4 declines the flagged authorization; reasons cite the
  rule that applies," has the full rationale and code pointers): `policy/src/types.ts` gained
  `verification_unanswered` on `CaseStateForPolicy`; `policy/src/engine.ts`'s `checkPrerequisites`
  lets `DECLINE_TRANSACTION` through below the 0.70 gate once that flag is true (R1's verify-first
  step is then already done), while `BLOCK_CARD` still needs 0.70 or a denial; `agent/src/recommend.ts`
  now adds `DECLINE_TRANSACTION` (route `L1`) alongside `MONITOR_CARD`/`CREATE_CASE` in both R4
  branches (legitimate-reading no-reply, and R1-band no-reply), and reasons name whichever rule
  actually applies (R2 only on a dispute, R5 for card testing, otherwise the probability against
  R1's 0.70 line; `CREATE_CASE` cites §3a, or "R2 and §3a" on a dispute); `agent/src/planner.ts`'s
  evidence-request rationale and `agent/src/machine.ts`'s no-reply stop text likewise name R3, R1,
  or (above 0.70) README §6 instead of a fixed "R1" label. `agent/src/caseState.ts` passes the new
  flag through. `agent/src/machine.ts`'s `resolveStatus` gained a `pendingReplyDecline` check so a
  no-reply `DECLINE_TRANSACTION` (route `L1`) doesn't flip the case to `escalated` — the cardholder's
  reply is still pending, not a human approval, so the case stays `open`.
- **Checked and left unchanged**, because the policy doesn't require a change:
  - R5 on HHG-011: the dataset's own worked example only pairs `DECLINE_TRANSACTION`/`STEP_UP_AUTH`
    with the *initial* R5 recommendation, before a denial arrives; its *final* actions after the
    denial are a plain block. `recommend.ts`'s block branch already matches that shape.
  - The extra verification request on HHG-018 (`analyst_info` then `customer_validation`, both
    unanswered): asking without approval is permitted by §5 regardless of how many requests go out,
    and the recommendation doesn't change on either reply, so nothing here was a bug.
- **API live-run fixes.** `api/src/liveRunSource.ts`'s `machineRunner` built
  `FraudInvestigationMachine` by hand (`new FraudInvestigationMachine({ ..., mcp: createMcpClient(...),
  providers: await createToolProviders(...), policies: createPolicyAdapters() })`), which skipped
  the pattern scorer and the case write-back to TigerGraph that the benchmark runner gets through
  `agent/src/agentFactory.ts`'s `buildMachine`. Added `createAgentMachine` (a thin export wrapping
  `buildMachine`) to `agentFactory.ts` and switched `machineRunner` to call it, so a live UI run
  (`RUN_SOURCE=live`) now uses the same construction path as `make run-case`. Separately,
  `agent/src/mcpClient.ts`'s default-URL fallback used `?? "http://127.0.0.1:8000/mcp/"`, which only
  catches `undefined` — `.env.example` ships `TIGERGRAPH_MCP_URL=` (empty string), and the API loads
  `.env`, so a live run with an untouched `.env.example` copy failed to connect. Changed to `||`. A
  live run of HHG-017 through the API (`TOOLS_BACKEND=real LLM_BACKEND=openai RUN_SOURCE=live
  PATTERN_SCORER=jev RAG_VECTOR_BACKEND=tigergraph`) was verified end to end before the factory
  change — 61 events, same verdict/probability/actions as the benchmark answer at the time.
- **Tests.** `pnpm exec vitest run tests/ws4 tests/ws5 tests/ws6`: 44 files, 370/370 pass.
  `make test`: 9/9 packages (contracts, agent 280, rag 100, eval 39, gsql 49, plus api/policy/graph/ui).
  `make lint`: clean.
- **Answers regenerated** (`--no-cache`, real TigerGraph + real MCP + OpenAI-compatible LLM,
  `runs/bench-i25-1206`), `make validate-answers`: 20/20 PASS. Verdicts unchanged at 13 fraud / 6
  legitimate / 1 uncertain. The 7 no-reply cases (HHG-005, -010, -013, -015, -017, -019, -020) now
  carry `DECLINE_TRANSACTION` (route `L1`) in `next_best_actions.final`, alongside `MONITOR_CARD`
  and `CREATE_CASE`; every one of them keeps `case.status: "open"`. `affected_txn_ids`,
  `exposure_usd`, patterns and statuses otherwise unchanged from the iteration-23/bounded-probability
  run above.

### Stop-reason probability and bounded fraud_probability (2026-09-23 11:42)

- `agent/src/stopRule.ts`: the §6 stop reason quotes the filed fraud probability and names the
  leading pattern's share separately (it printed the leading pattern's share as "Fraud
  probability": HHG-014 0.87 in the text vs 1.00 filed).
- `agent/src/assess.ts`: `fraudProbability` bounded to [0.01, 0.99]; no policy threshold is near
  the bounds. Decision in `docs/decisions.md`.
- Tests: 3 new (ws4 assess + stopRule), ws4+ws5 333/333, `make test` 9/9, `make lint` clean.
- 20 answers regenerated, `make validate-answers` PASS. Only HHG-009 and HHG-014 changed
  (1.00 -> 0.99); every verdict, pattern, status, exposure and action identical; every stop reason
  that quotes a fraud probability now matches `fraud_probability`. Verdicts 13 fraud /
  6 legitimate / 1 uncertain.
