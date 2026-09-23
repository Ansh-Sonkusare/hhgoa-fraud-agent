# Todo

Living task list. Check items off in place; don't delete history — move completed items to the "Done" section instead of erasing them, so this doubles as a lightweight record of what's actually finished.

## Now (2026-09-23 — submission)

- [x] API + UI demo check, live and fixture modes, including a headless-browser run of both demo
      cases (HHG-006, HHG-017/HHG-020) and the Approve click. Fixed on the way: the Evidence
      Requests panel read the reply from the wrong field and labelled it "Assumed response"; a live
      run's `done` event reached the UI before the answer was stored (answer panels empty until a
      reload); ad-hoc queue rows showed no ids; the New Trigger examples used ids not in the data;
      the explanation's "why more evidence" always cited R1, even at 0.37 (R3) or above 0.70 (§6).
- [x] Regenerate the 20 answers with the explanation-citation fix → `make validate-answers` →
      rebuild the two fixtures → commit and push (20/20 valid; verdicts and actions unchanged).
- [ ] Record the demo video from `submission/demo_script.md` (live; HHG-910/920 fixtures as
      fallback).
- [ ] Publish the blog post (`submission/BLOG_POST.md`, local only until published).
- [ ] Post on social (`submission/SOCIAL_POST.md`) linking the blog or video; tag TigerGraph.
- [ ] Optional, cosmetic: the neighbourhood graph draws large shared-entity groups off-centre.
- [ ] Parked: Kev local pattern scorer (export 1,419/1,584 states; Jev is in use).

## Now (WS0 — must land before m0)

- [x] `fixtures/case-run-ambiguous.json` — the fixtures fork only delivered `case-run-clear-fraud.json`; wrote the ambiguous one by hand (case `HHG-920`), same ID conventions.
- [x] `tests/ws0/*.test.ts` (6 files from the tests fork) + `tests/ws0/fixtures.test.ts` (written by hand — fixtures didn't exist yet when that fork ran) — covers all schemas, every `answerFile.ts` cross-field rule, all 26 fakes (envelope + `as_of` echo), both fixtures.
- [x] `pnpm install` at repo root.
- [x] `make test-contracts` green — 7 files, 83 tests passed.
- [x] `pnpm --filter @hhgoa/contracts typecheck` clean.
- [x] Reviewed both forks' unsolicited edits: `contracts/src/answerFile.ts` (`sar.file===true` requires non-empty `narrative` — correct, kept), `contracts/tsconfig.json` (`noEmit: true` — correct, kept), `contracts/vitest.config.ts` (new, needed — kept), root `package.json` (`"type": "module"` + hoisted devDeps — correct, kept). Restored `.env.example` to the fuller version after the fixtures fork trimmed it (see `docs/logs.md`).
- [x] Commit WS0 work in small, reviewed chunks (done; see git history).
- [x] Tag `m0`, push tags.
- [x] Report STEP 1 done per PRD §16's WS0 acceptance criteria.

## Now (infra prep before STEP 2 kickoffs)

- [x] `.env` created from `.env.example` (gitignored, not committed).
- [x] Decision: TigerGraph via local Docker CE (`docker-compose.yml`, root), not Savanna — see `docs/decisions.md`.
- [x] Decision: LLM swapped to local Ollama (no API key), Groq wired as optional fallback — PRD §5/OQ7 updated in place, see `docs/decisions.md`.
- [x] TigerGraph CE running and verified: REST API (`/echo`) responds, GSQL shell authenticates (`tigergraph`/`tigergraph`), `.env` filled in with working `TIGERGRAPH_HOST`/`USERNAME`/`PASSWORD`. Image is `tigergraph/community:4.3.0-rc1`, loaded from the dl.tigergraph.com download (not pulled from a registry tag) — see `docs/decisions.md` for the full story including the failed Enterprise-image attempt.
- [x] ~~Ollama~~ superseded: the LLM is local llama.cpp `llama-server` (Qwen2.5-7B-Instruct Q4_K_M, OpenAI-compatible, `LLM_BACKEND=openai`).
- [ ] Optional hardening (not urgent, localhost-only): change default `tigergraph` password via `gsql ALTER PASSWORD tigergraph` before any non-local exposure.
- [x] Flagged and resolved: `tigergraph-mcp` runs as the one isolated Python exception (`graph/mcp-server/`, see `docs/decisions.md`).

## Now (STEP 2 review — what's actually merged vs PRD §16 DoD)

The four parallel implementation workstreams (WS1 `graph/`, WS3 `rag/`, WS4+WS5 `agent/`+`policy/`, WS6 `api/`+`ui/`) were reviewed against PRD §16 and merged into `main`. `make test` is green (9/9 tasks: contracts 83, agent 71, policy 54, api 35, rag 95), typecheck clean across TS packages. **But a PRD recheck (2026-09-19) shows most DoD rows are only "merged & green on fakes/fixtures" — the real-tools wiring is largely NOT done.** Per-workstream reality:

- [x] WS0 (contracts/) — 83 tests green, fakes return valid envelopes, answer schema reconciled with README.
- [x] WS1 (graph/) — schema.gsql, loading jobs, 3 sample queries (`sample_txn_explain`/`sample_card_velocity`/`sample_link_analysis`) + `graph_stats` installed; `make verify-graph` passes; MCP server running and `mcp:smoke` (3 queries via MCP) works.
- [x] **WS1 full-dataset load (2026-09-19)** — `prepare-load` (no `--max-transactions`) + `verify` loaded the FULL real data (~590,742 txns, 5,565 closed cases, 20 case-pack); all vertex/edge counts match; **`FLAGGED_TXN 20/20` now matches** (resolves the deferred smoke finding); `mcp:smoke` green.
- [x] **WS1 repro gap fixed (2026-09-19)**: `graph/mcp-server/venv` rebuilt properly in the main tree (`python3 -m venv` + `pip install tigergraph-mcp==1.0.3`), the leftover worktree's venv was unusable anyway (broken `pip` symlink after relocation). `graph/mcp-server/venv/` added to `.gitignore` (79MB, was previously untracked with no ignore rule — a real risk of an accidental `git add -A` committing it); `graph/mcp-server/.env.example` added (committed, non-secret CE demo defaults) since `.env` itself stays gitignored. Setup steps documented in `docs/MCP_TOOLS.md`. Server started via `pnpm --filter @hhgoa/graph mcp:start` and left running for the WS4 real-backend work below.
- [x] **WS2 (gsql/) DONE (branch `ws2-gsql`, worktree `/home/teak/code/wt-gsql`)** — all 21 `.gsql` files (10 contract queries incl. `detect_patterns`, 5 detectors, 4 algorithms, 2 discovery queries) installed and passing against the live full-dataset graph. `make verify-gsql` wired into the root Makefile and green end to end (install all queries + run algorithms/discovery + `tests/ws2/*.test.ts`, 42/42 tests, 5 files). Verified idempotent against a simulated WS1 reset (`DROP QUERY ALL` + cleared discovered `Pattern`s, no data reload needed — full `make verify-graph` DROP-ALL-and-reload isn't runnable from this worktree since `graph/build/`/`data/` are gitignored and only exist in the main tree/checked out branch that produced them): `install.ts` fully self-heals. `docs/IDENTITY_VALIDATION.md` written (100% purity, 38.1% customer split rate, plus a not-yet-actioned improvement idea). WS1's own sample queries, which the idempotency test also dropped, were restored before finishing. **WCC giant-component limitation fixed**: requiring 2+ shared entity types (not 1) to connect two cards dropped the residual from ~3,959 cards to a max of 274 — see `docs/decisions.md` for the investigation and the fix, plus a second bug it surfaced (stale discovered `Pattern`s never cleared across reruns, fixed by splitting `discovery_clear`/`discovery_report` into separate query invocations after finding `DELETE`+`INSERT INTO` of the same vertex id in one query silently nets to a deletion on this build). **Then fixed properly (2026-09-19, follow-up)**: investigating the 274-card residual showed it was a *transaction-volume artifact*, not a ring — 43% of all transactions on 1.7% of cards, 17.8x the average entity footprint, and a confirmed-fraud rate (81.6%) *below* the 83.2% dataset baseline, yet it was the only thing discovery emitted. Root cause was that the bipartite Card↔entity projection had only its *entity* side guarded; added a card-side guard (`min_overlap_pct=30`, a Jaccard bar on each pair's uncapped footprint) and loosened `max_hub_degree` 25 → 1000 (a cap of 25 was discarding 98-99% of all address/email edges). Largest component 274 → 41, multi-card communities 7 → 241, discovered patterns 1 (81.6% confirmed) → 3 (100% confirmed). Also fixed two further defects found en route: discovery's qualifying bar was `>= 0.5` i.e. *below chance* against the 83.2% baseline (now `min_confirmed_pct=90`), and the `community_lookup` ↔ `discovery_report` community-id invariant was silently false because the two used different adjacency rules (now identical; regression-tested). `shortest_path`/`label_propagation` deliberately stay on the looser rule — reasoned positions, documented. **Review pass (2026-09-19, second follow-up)**: independently re-verified the above (found the graph had drifted to `pendingInstall` state despite a "green" report — reinstalled and re-confirmed all headline numbers match). Found and fixed two more real gaps: the "capped at 3h" note had misread the actual PRD sec.12 text (a 3-hour implementer time-box, not a "top 3" runtime spec — the top-3 cap itself is kept, just the stated rationale corrected), and PRD sec.12's required discovery stats (`size, velocity, shared-device density, risk-score distribution`) were missing `velocity`/`shared_device_density` from both `community_lookup.gsql` and `discovery_report.gsql` — added both, plus `avg_risk_score` to `discovery_report.gsql` for consistency. `make verify-gsql` green, 44/44 tests (up from 42). See `docs/decisions.md` for detail.
- [x] WS3 (rag/) — 95 tests green; ingestPolicy/ingestCases read real `data/*.csv`; retrieve/contextBuilder (bundle ≤6k tokens)/memory implemented.
- [x] **WS3 DoD graph-native vector search** — done 2026-09-23 (#19): policy chunks and case memory are scored in TigerGraph by `vector_search` (`RAG_VECTOR_BACKEND=tigergraph`, `rag/src/store/tigergraphIndex.ts`), 29 PolicyChunk + 5,565 FraudCase embeddings synced, agent write-back mirrors the embedding into the graph. Parity tests + live ws2 tests green.
- [x] WS4 (agent/) — state machine, MCP client wrapper, tool registry, assessor + confidence guard, VOI planner, explainer, prompts — 71 tests green against fakes.
- [x] **WS4 DoD "real-tools switch works" — DONE (2026-09-19)**. `agent/src/mcpClient.ts`'s `RealMcpClient` previously called MCP tools by contract name (`resolve_trigger`, etc.) and parsed responses as bare JSON — both wrong against the live server (confirmed live: the only real MCP tool is `tigergraph__run_installed_query`; every response is a markdown-fenced JSON block inside `content[0].text`, `{success, data:{result:[...]}, error?}`, `isError` stays `false` even on a query failure — the real signal is `success`). Rewrote `callTool` to route all 10 graph tools through that one MCP tool at WS2's installed query names, with a per-tool transform from each query's raw PRINT shape to the exact contract shape (entity-type case mapping, map→array conversions for `shared_rings`/`detect_patterns`, field renames for `neighborhood`/`card_velocity`/`txn_history`/`get_community`). `agentFactory.ts`'s `createToolProviders("real")` now also wires WS3's real RAG runtime (`@hhgoa/rag`'s `createRagRuntime()`, already fully built — the "WS3 not up yet" half of the old throw was stale) for `retrieve_policy`/`retrieve_similar_cases`/`lookup_external`, plus a new in-memory `InMemoryCaseLedger` (`agent/src/caseLedger.ts`) for the 8 `case_*` tools (case identity is caller-assigned via `RunAgentOptions.caseId`, not graph-persisted — a deliberate scoping call, see `docs/decisions.md`). `get_wide_features` (local DuckDB) and the never-actually-invoked-through-providers members (the 10 graph tools + `policy_check`/`execute_action`/`generate_sar`/`request_evidence`) fail loudly rather than silently return fake data under `TOOLS_BACKEND=real`. **Verified end-to-end against the live graph + real data** (not just typecheck): a full real run on the real HHG-001 trigger (txn `3514030`) correctly resolved card/customer/identity, pulled real transaction history/shared-device rings/prior cases, triggered a real RAG-backed `request_evidence` round, and reached a coherent `escalated`/`card_testing`/0.89 verdict. Caught and fixed 2 real bugs live: (1) `ToolRegistry`'s silent case accessors always key off the externally-supplied `caseId`, never what `case_open` returns — the ledger's first version generated its own id and everything after `case_open` threw "unknown case_id"; (2) `find_shared_entity_rings` returned a ring of several hundred cards through the same missing-value sentinel device WS2 already excludes from community detection (`shared_rings.gsql` has no hub cap by design) — added a `MAX_PLAUSIBLE_RING_SIZE=50` filter in the transform layer. `make test` green across all 9 workspace packages (367 tests total) and `pnpm --filter @hhgoa/agent typecheck`/`@hhgoa/rag typecheck`/`@hhgoa/policy typecheck` all clean after the change.
- [x] WS5 (policy/) — policy.yaml, engine, responders, approval channels (UI/Discord), mock actions, SAR — §10.5 tests green (54).
- [x] WS6 (api/ + ui/) — Fastify + SSE + full Next.js UI (case queue, case detail panels, approvals inbox — see `ui/screenshots/*.png`) — 35 api tests green.
- [x] **WS6 DoD "runs from a real run" — DONE (2026-09-19)**. New `api/src/liveRunSource.ts` implements the `RunSource` seam (plus a `LiveFeed` surface) and drives the real WS4 machine: `buildTriggerFromCasePack()` maps the 20 case-pack entries to live `Trigger`s with `opened_at` as `as_of`; `machineRunner` composes `FraudInvestigationMachine` from `@hhgoa/agent`'s public API with the same env defaults as `runAgent` (`TOOLS_BACKEND=real|fake`, `LLM_BACKEND=ollama|mock`; the import is dynamic so fixture mode never loads WS4's module graph); every emitted `AgentEvent` is schema-validated at the source boundary and buffered/broadcast to SSE subscribers, and a completed run materializes as a `RunRecording`. `api/src/replaySession.ts` gained a `RunSession` interface + `LiveSession` (pending approvals derived from the live stream; `resolveApproval` feeds a synthetic `action_result` back into the feed) and the registry became a generic `SessionRegistry(factory)` that prefers a live session when the source supports the case. `api/src/server.ts` + `api/src/env.ts` gate the source on `RUN_SOURCE` (`"fixture"` default, `"live"` for the real agent; `WS6_RUN_SOURCE` alias); POST /api/cases registers ad-hoc triggers as live-runnable; `.env.example` documents the switch; `@hhgoa/agent` added to api deps. Api tests: 20 → 35 (new `tests/ws6/liveRunSource.test.ts` ×10 + `liveServer.test.ts` ×5, using a fake `LiveRunner`). Smoke-verified end-to-end with the REAL machine (fake graph + mock LLM for a self-contained run): HHG-001 completed in ~3s, 32 schema-valid events, verdict `fraud`/`card_testing`. Flipping `RUN_SOURCE=live` + `TOOLS_BACKEND=real` + `LLM_BACKEND=ollama` runs the live graph + real Ollama over the same pipeline (that exact combo was already verified at the agent layer, 291375f). Remaining WS6-side gaps: the 20 case pages now populate live, but "before opening a case it shows nothing" is inherent to live runs; the UI still needs a `RUN_SOURCE=live` flag/verdict pass (see `ui/`). **Superseded 2026-09-23:** `machineRunner` no longer composes `FraudInvestigationMachine` by hand — it now calls `createAgentMachine` (`agent/src/agentFactory.ts`), the same factory the benchmark runner uses, because the hand-built version skipped the pattern scorer and the case write-back to TigerGraph on every live run. See `docs/decisions.md`, 2026-09-23.
- [x] **WS6 UI + screenshots + turbo build — DONE (2026-09-19)**. UI fixed for live mode: `CaseListItem.status`/`CaseDetail.session.status` + `StatusChip` now handle `error`; `CaseDetailView` refetches the AnswerFile when the SSE stream hits done (so live verdict/SAR/recommendations panels populate without a manual reload) and unwraps the live machine's nested `payload.explanation` event (WS0 fixtures store a flat payload — crash found and fixed by the new live-mode screenshots); run-failure banner + accurate complete/no-run text. Monorepo: `turbo.json` `build.outputs` now includes `.next/**` (kills the "no output files" warning and enables caching — `FULL TURBO` on rebuild) and root gained a `build` script. Screenshots: new `ui/scripts/screenshot.mjs` (playwright-core against the cached chromium) captured `ui/screenshots/ws6-live-case-hhg-001.png`, `ws6-live-streaming.png`, `ws6-live-queue.png`, `ws6-live-approvals.png` from real live runs (HHG-001/002/003 → `fraud`, verified by DOM text; explanation/SAR panels populated). Context7 note: headless chromium uses `nix-shell`-provided libs on NixOS (`/tmp/opencode/chrome-libs.nix`, outside the repo).
- [x] **WS7 (eval/) DONE (2026-09-20)** — harness + output + real run.
  - Harness: `eval/src/runBenchmark.ts` (case loop, per-run dir under `runs/<timestamp>/`, replay cache keyed on trigger+mode+as_of — pass `--no-cache` for forced fresh runs, `--plan-only` to dry-run, `--timeout <s>`/`CASE_TIMEOUT_S` per-case cap, `--case` for a single case), `runModeFromEnv` (`TOOLS_BACKEND=real|fake`, `LLM_BACKEND=ollama|mock` + Ollama preflight), `backtest.ts`, `exportAnswers.ts` (schema-validated answers via `@hhgoa/contracts`, error markers written as `{_error:true}` with `case_id`), `validate.ts`/`validateAnswers.ts` (schema + cross-field rules + dataset-id resolution), `metrics.ts`. Root `Makefile` `run-case`/`run-all`/`validate-answers` wired to `pnpm --filter @hhgoa/eval`; `run-case` passes `--case $(CASE)`.
  - Leakage guard: `tests/ws7/noLeak.test.ts` builds RAG/memory options that ignore anything after `as_of` (verified against the real 590,742-txn dataset).
  - **Full real run complete (2026-09-20)**: all 20 case-pack cases ran on the real graph (WS1 full load) + real Ollama `qwen2.5:1.5b`, `from_cache:false` — `runs/20260920-001917`, answers written to `cases/*.json` (defaults: `runs/`, repo-root `cases/`).
  - **Validation green with real answers (2026-09-20)** — fixed the earlier false failures: `eval/src/dataset.ts` `loadIdIndex` now indexes the full id universe — reconstructs WS1's derived card ids (`C<card1>-K<rank>`, same cardinality/ranking logic as `prepareLoadFiles.ts`) and unions the graph's materialized entity files (`graph/build/cards.csv`, `stub_cards.csv`, `customers.csv`, `devices.csv`, `identities.csv`, `email_domains.csv`, `addresses.csv`); `eval/src/validateAnswers.ts` recognizes the case ledger's synthetic `graph_case_id` prefix `GRAPH-<case_id>` as run-assigned (caseLedger mints it because the graph has no case vertices on this build — `ALTER GRAPH` unsupported), so only genuinely unknown ids warn. Result: `pnpm validate-answers` = **PASS, 20/20, no warnings**; `tests/ws7/` 32/32 green; eval typecheck clean.
  - Did NOT commit: `data/` (gitignored), `graph/build/` (gitignored), `runs/` (gitignored); the 20 real-answers JSONs in `cases/` ARE committed as the deliverable.
- [x] WS8 (submission/): `BLOG_POST.md` and `demo_script.md` refreshed to iteration 23 and the R4 change; social post drafted (`SOCIAL_POST.md`). All three stay local, never committed. Demo video and posting tracked in "Now (2026-09-23 — submission)".
- [x] Real-time vs static: **PRD §2 lists "real-time streaming" as an explicit NON-GOAL.** Data is the static IEEE-CIS-derived `data/*.csv`. The SSE stream is agent-event streaming of a (fixture/replay) run, NOT live transaction data. Nothing to implement.
- [x] Ollama: installed & tested — `qwen2.5:1.5b` pulled, server running on `:11434`, `OLLAMA_MODEL` set in `.env`, full 32-event agent run driven end-to-end (291375f). Cloud models (gemma4:31b etc.) were attempted but the local binary 0.30.5 pulls them as local registry lookups and they're not usable via the `/api/chat` path — local small model works, stick with it. Also fixed `llm.ts` to read `OLLAMA_HOST` (repo convention) + env-loader inline-comment parsing.
- [x] (Duplicate of the optional password-hardening item under "infra prep"; tracked there.)

## Now (accuracy push — agreed sequence, 2026-09-22)

1. **Multi-stage prompt flow, then iterate.** Wire the six unreachable builders
   in `agent/src/prompts.ts` (`systemPrompt`, `investigatorPrompt`,
   `triageSystemPrompt`, `calibrateSystemPrompt`, `evidencePlannerSystemPrompt`,
   `explainerSystemPrompt`) plus `TRIAGE_JSON_SCHEMA` into a real staged loop.
   Only `assessSystemPrompt` currently runs. Re-measure after each stage lands.
2. **Then Kev, only if still needed.** `github.com/jaredpalmer/kev` — decision
   models (0.8B/4B/9B on Qwen3.5) returning probability distributions over
   `choice`/`noul`/`score` questions. Allowed by the organiser for routing and
   scoring; the LLM must still write the answers. Prefer 0.8B on memory grounds.
3. **Lower the main LLM context to make room.** llama-server runs `-c 16384`
   (~5.5 GiB) and must shrink so Kev co-resides on the GPU. Blocked on shrinking
   the assessor brief first (`.env` documents ~13k tokens needing `-c 16384`) —
   staged prompting should reduce it naturally.

Open defect to fix alongside: **3/3 cleared cases escalate** (100% false
positive). Recall is solved (0/17 false negatives); discrimination is not.
`card_not_present_fraud` is the new magnet class at 9 of 20 predictions.

**Kev trigger (user, 2026-09-22; revised same night).** Originally two more
iterations (5 and 6); iteration 6 missed the bar (pattern 41.2%, FN 0/17,
cleared 2/3 called fraud + 1 uncertain). The user then extended it: **go to
iteration 10 on the current approach before Kev.** If after
iteration 10 the 20-case run does not reach **pattern exact >= 47.1%** (the
leak-free baseline), **false negatives <= 2/17**, and **cleared escalated
< 3/3**, iteration 11 is Kev (`github.com/jaredpalmer/kev`, 0.8B first) as the
pattern/probability scorer, with the main LLM kept for summaries, SAR
narratives and explanations. Requires lowering llama-server `-c` to fit both
on the GPU (see the accuracy-push sequence above).

Before editing any prompt, check it has a call site — six of seven do not, and
one earlier fix was silently lost that way.

## Standing reminders (don't re-litigate)

- OpenCode is now the active implementation agent for this project (this session runs in OpenCode / `big-pickle`). The "delegation paused → Claude Code implements directly" stance from the 2026-09-18 decision is superseded — update `CLAUDE.md`/`docs/decisions.md` if you re-adopt that stance later.
- `contracts/` is frozen after `m0` — changes after that need explicit human OK.
- Never commit `data/` or any `*.csv`.
- Every graph/RAG/memory tool must carry `as_of` (PRD §8.1) — already enforced in `contracts/src/tools.ts` signatures; keep it that way in real implementations.

## Done

- [x] STEP 0: git init, `.gitignore`, initial commit, private GitHub repo created and pushed, CSVs moved to gitignored `data/`.
- [x] Switched monorepo tooling from npm workspaces to pnpm workspaces + Turborepo (PRD.md/CLAUDE.md text updated to match) per explicit user instruction.
- [x] CLAUDE.md updated to pause OpenCode delegation.
- [x] `contracts/src/*.ts` (all 9 files) + `index.ts` barrel written.
- [x] `contracts/examples/*.json` (26 tool fixtures) written, IDs corrected to match real numeric TransactionID format after checking `data/*.csv` headers.
- [x] Root skeleton: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `Makefile`, `.env.example`, per-workstream stub `package.json` files.
- [x] `fixtures/case-run-clear-fraud.json` written.
- [x] `fixtures/case-run-ambiguous.json` written.
- [x] `tests/ws0/*.test.ts` (7 files, 83 tests) written and green; typecheck clean.

## Iteration 2 — MUST FIX FIRST (user-flagged, 22:2x)

- [x] **Two-stage assessor → measured switch, default single-stage.** iter 1b: 17.6% / 6 FN / 60% vs single 47.1% / 0 / 85%. `ASSESSOR_STAGES` (default 1). decisions.md has the table.
- [x] **Iteration 2** measured and logged (docs/logs.md).
- [x] After iter 2: cleared-case over-escalation pursued on the evidence side in iterations 5–11 (see below), never via the 0.4 threshold.

- [x] **CC-4386 regression — ROOT-CAUSED + FIXED, measurement pending (iteration 2).** Also CC-2247, CC-5194. Cause: two-stage triage could drop every fraud hypothesis before calibration → topFraud absent → p=0. Fix: calibration always gets the best-supported fraud candidate (assess.ts, 4 tests). Original note: In the leak-free
      iteration-1 run it was `uncertain`/`card_not_present_fraud` (pattern correct).
      Iteration-1b (calibration realignment + exculpatory evidence + email-ring
      demotion) pushed it below the 0.4 legitimate line. A false negative on
      confirmed fraud is the costly direction and was 0/17 before this change.
      Diagnose from `eval/backtest-detail.json` (fraud_probability, evidence counts)
      once bt_iter1b finishes, then re-run `CC-4386` alone via
      `eval/src/rerunCases.ts` for the full hypotheses. Suspects, in order:
      (1) the new exculpatory items outweighing a thin brief — this case had only
      3–4 evidence items in earlier runs; (2) the email-ring demotion removing the
      only corroboration it had; (3) calibration prose now under-stating a lone
      CNP signal. Do not accept a fix that lowers the legitimate threshold — fix
      the evidence, not the line.

- [x] **Iteration 4:** card_testing / account_takeover detectors rewritten to measured gold shape; card_testing 3/3 detected. Logged.
- [x] **Cleared-case false-block** — resolved by alert calibration (iterations 22–23): 0/10 cleared blocked on the fresh 50, 0/8 on the original 50; 5/31 in the held-out alert replay, whose evidence profile is ~85% fraud in history (`docs/logs.md`). Was: 20-case runs since iteration 13: 1/3 escalated (CC-1660). 50-case run (iteration 17): 4/8 escalated, 3/8 blocked. Gap analysis in progress (`docs/logs.md`, "Gap analysis dispatched").
- [x] **Waiter discipline:** key waiters on the `node` worker / chain script PID (`pgrep -af`), never on `pgrep -f <pattern> | head -1` from the launching shell — it self-matches three times tonight.

## Iteration 11+ (2026-09-23)

- [x] Iteration 11 ran (11b: 41.2%, cleared 3/3); results in `docs/logs.md`.
- [x] Kev trigger re-check: 11b/12/12b missed the bar; iteration 13 (no scorer, R1 guard) met it
      (47.1%, FN 0/17, cleared escalated 1/3). Kev/Jev stays wired but off; next lever for the
      card_not_present_fraud magnet.
- [x] (Fixed in iteration 22: now `legitimate`, not blocked.) CC-1660 cleared alert still escalated with two independent signals (ring + prior fraud on card).
- [x] Iteration 14 (evidence fixes) 6/17 = 35.3%: misses the Kev bar again; pattern choice by the 7B
      assessor is input-fragile at temperature 0. Next lever per the Kev trigger: pattern scorer
      (Jev hosted, or Kev local after finishing the export: 1,419/1,584 train states written).
- [x] Jev pattern scorer (iterations 15-17): 8/17 → 8/17 → 10/17 = 58.8% with full, annotated
      state. Remaining: online-flagged cases named ATO by Jev; undocumented not rankable by Jev.
- [x] Regenerate all 20 benchmark answers once numbers settle; `make validate-answers`. **Done
      (2026-09-23), after the R4-decline / reason-citation fixes** (`docs/decisions.md`, "R4
      declines the flagged authorization"): 20/20 validate; verdicts unchanged at 13 fraud / 6
      legitimate / 1 uncertain; the 7 no-reply cases now carry `DECLINE_TRANSACTION` in
      `next_best_actions.final`.
- [x] (Done: iterations 18–20.) Gap analysis (3 subagents: cleared alerts, pattern misses, undocumented) → implement → tests →
      one 50-case run. Baseline to beat: iteration 17 on 50 = 32/42 patterns (22/25 on the 30 new),
      0 FN, cleared 4/8 escalated / 3/8 blocked.

