# Project context (living snapshot)

Read this first when resuming work — it's the fastest way back up to speed. Update it whenever the state below goes stale; don't let it drift.

## What this project is

TigerGraph Hacker House Goa hackathon: an agentic fraud-investigation system over an IEEE-CIS-derived card-transaction dataset. Full spec lives in `PRD.md` (binding plan) and `docs/DATASET_README.md` (binding dataset/answer-format/policy — the dataset README wins on any disagreement). `docs/DATA_MAP.md` reconciles the two.

## Repo state

- Private GitHub repo: `Ansh-Sonkusare/hhgoa-fraud-agent`, branch `main`, pushed (origin synced to `002ddfb`).
- Raw dataset CSVs live in `data/` (gitignored) — never commit them. **`data/` holds the REAL dataset** (~590k txns, ~144k identity rows, 5,565 closed cases, 20 case-pack cases) and **the graph now holds the FULL real load** — see "Full dataset loaded" below.
- Stack: TypeScript end to end, Node 20+, **pnpm workspaces + Turborepo** (switched from npm workspaces per user instruction — see `docs/decisions.md`), `tsx`, `zod`, `vitest`. The only non-TypeScript code is `.gsql` (WS1/WS2) and one narrow Python exception for the official `tigergraph-mcp` server — see `docs/decisions.md`.
- **STEP-2 implementation workstreams are merged into `main` and their tests are green** — but a PRD §16 recheck (2026-09-19) found most workstreams are green only "on fakes/fixtures"; the real-tools wiring is largely NOT done. See the "STEP 2: merged — but mostly fakes/fixtures" section below for the honest gap list.
- `make test` runs 9/9 tasks (contracts 83, agent 71, policy 54, api 20, rag 95 — all passing), typecheck clean across contracts/rag/agent/policy/api, `make verify-graph` passes. WS0 tag `m0` exists.

## Directory ownership (PRD §6 — do not cross these lines)

`contracts/` WS0 (frozen after M0) · `graph/` WS1 · `gsql/` WS2 · `rag/` WS3 · `agent/` WS4 · `policy/` WS5 · `api/`+`ui/` WS6 · `eval/`+`cases/` WS7 · `submission/` WS8 · `docs/`, `fixtures/` WS0.

## WS0 status (as of this writing)

Done:
- Root skeleton: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `Makefile`, `.env.example`, per-workstream placeholder `package.json` stubs (graph/gsql/rag/agent/policy/api/ui/eval).
- `contracts/src/`: `toolEnvelope.ts`, `evidenceItem.ts`, `state.ts`, `agentEvent.ts`, `assessment.ts`, `answerFile.ts` (the binding schema, with cross-field `.superRefine()` checks), `policy.ts`, `tools.ts` (26-tool catalog, typed signatures only), `fakes.ts` (in-memory fakes for all 26 tools), `index.ts` barrel. Plus `contracts/vitest.config.ts` (points at `../tests/ws0`).
- `contracts/examples/*.json` — 26 files, one `data` payload per tool, fake IDs in a clearly-synthetic range (see "ID conventions" below).
- `fixtures/case-run-clear-fraud.json` and `fixtures/case-run-ambiguous.json` — both written, both validate.
- `tests/ws0/` — 7 files, 83 tests, all green: schema validity + enum rejection for every contract type, every `answerFile.ts` cross-field rule (positive and negative), all 26 fakes (envelope shape + `as_of` echo), both fixtures.
- `pnpm install`, `make test-contracts` (green, 83/83), `pnpm --filter @hhgoa/contracts typecheck` (clean).

Not yet done:
- Commit everything in small, reviewed chunks (contracts/, tests/, fixtures/, root infra, docs — not one giant commit).
- Tag `m0` and push tags.
- Report STEP 1 done per PRD §16's WS0 acceptance criteria, then move to STEP 2 (WS1-WS6 kickoffs).

Note on background forks (full story in `docs/logs.md`): one fork stayed fully in scope (tests) and delivered clean work including a correct root `package.json` infra fix. The other (fixtures) went out of scope — it rewrote `Makefile`, `.env.example`, and all four `docs/*.md` files despite being told not to touch `docs/`, apparently having lost track of which of two simultaneously-dispatched forks it was. Its actual assignment was only half-delivered (`case-run-clear-fraud.json` only); the ambiguous fixture was written by hand afterward. The docs/env rewrites were reviewed and are accurate, so they were kept rather than reverted a third time — but this is a caution for next time: avoid dispatching multiple forks in one message when their prompts reference each other's task, and don't assume a fork honored an explicit no-touch list without checking.

## ID conventions used in examples/fixtures (do not confuse with real dataset rows)

Real dataset formats (confirmed from `data/*.csv` headers): `TransactionID` is a plain numeric string (e.g. `"3514030"`); `customer_id` looks like `"C12382"`; card ids look like `"C12382-K1"`; closed-case ids look like `"CC-0141"`. Our synthetic fixtures use ids clearly outside the real ranges we've seen so nobody mistakes them for dataset rows: transaction ids `"99xxxxx"` / `"991xxxx"`, customers `"C0910x"`/`"C0920x"`, closed cases `"CC-09xx"`.

## Key decisions

See `docs/decisions.md` for the full log with rationale. Headlines: pnpm+Turborepo (not npm workspaces); OpenCode delegation paused, Claude Code implements directly for now.

## STEP 2: all implementation workstreams merged and green

WS0 (STEP 1) was committed in reviewed chunks, tagged `m0`, and pushed. Infra for STEP 2 (TigerGraph Docker CE, Ollama LLM swap, `.env`, MCP-as-Python exception) is working as described below. All four parallel workstreams (dispatched as `isolation:"worktree"` background agents — WS1, WS3, WS4+WS5, WS6) were then reviewed against their PRD §16 definition of done and merged into `main` sequentially:

- WS1 `graph/` merged (fast-forward) — schema + queries + `make verify-graph` wiring; `make verify-graph` passes against the running CE container.
- WS3 `rag/` merged (`cb50f0e`, merged `9ffa53f`).
- WS4+WS5 `agent/`+`policy/` merged (`fab1533`, merged `be642c6`).
- WS6 `api/`+`ui/` merged (`d53947b`, merged `881c889`), plus `82fe080` restoring `api/src/data/casePack.ts` (a source file that had been swallowed by the broad `data/` gitignore rule — fixed with a `!api/src/data/` exception) and `7334b93` reconciling the ws3 test suite to the merged rag API (the tests had drifted from the contract-correct implementation; `@hhgoa/rag` is now 95/95 and typecheck-clean instead of 12 failing / 21 TS errors).

Each merge's `pnpm-lock.yaml` conflict was resolved by taking the expected copy (`git checkout --theirs` + `pnpm install --lockfile-only`), then one full `pnpm install` to create the `@hhgoa/*` workspace symlinks.

Remaining known edges (non-blocking, tracked in `docs/todo.md`): WS2 `gsql/` (deliberately held back until WS1's schema landed — can now start; still the biggest gap), WS7 `eval/` (after WS4 emits real events), WS8 `submission/` (continuous). The `FLAGGED_TXN=0` smoke finding was **resolved by the full load**: `FLAGGED_TXN 20/20` now matches.

## STEP 2: merged — but mostly fakes/fixtures (recheck, 2026-09-19)

PRD §16 recheck vs the merged `main`. Green-on-tests ≠ done against DoD for most workstreams:

- WS0 `contracts/`: done (83 tests; fakes; answer schema reconciled with README).
- WS1 `graph/`: **FULL REAL DATASET NOW LOADED (2026-09-19) and `make verify-graph` passes on it** — 590,742 txns, 14,845 customers, 37,531 identities, 5,565 fraud cases, and the previously-deferred `FLAGGED_TXN 20/20` count now matches. Schema, loading jobs, 3 sample queries + `graph_stats` installed; MCP smoke (3 queries via tigergraph-mcp) succeeds. **Remaining WS1 repro gap:** `graph/mcp-server/` (the `tigergraph-mcp` Python venv + its `.env`) is **untracked** — it only exists in the leftover WS1 worktree under `.claude/` (gitignored), so a clean main clone can't start MCP yet. Needs a setup doc/script before D1 (clean-clone run).
- WS2 `gsql/`: **NOT STARTED** — `gsql/` is a `package.json` stub. The 8+ installed queries, 5 pattern detectors, WCC/Louvain, discovery, and `docs/IDENTITY_VALIDATION.md` are all missing. Biggest gap: blocks R2, the agent's real graph tools, RAG's graph-expansion half, and the `gsql/` column of `docs/MCP_TOOLS.md`.
- WS3 `rag/`: implemented (95 tests) — reads real `data/*.csv`, context bundle ≤6k tokens, memory. **But** `vectorStore.ts` is a local adapter; graph-native vector search + "memory write visible in graph" (DoD) are blocked on WS1 vector queries / WS2 (open WS3→WS1 REQUESTS.md item).
- WS4 `agent/`: implemented against fakes (71 tests) — state machine, MCP client, tool registry, assessor, VOI planner, explainer. **`TOOLS_BACKEND=real` throws** in `agentFactory.ts`; default run = `MockLlmClient` + contracts fakes.
- WS5 `policy/`: done (54 tests) — §10.5 guarantees hold; real policy paths + UI/Discord approval channels wired.
- WS6 `api/`+`ui/`: Fastify + SSE + full Next.js UI (see `ui/screenshots/*.png`, incl. live-mode shots; 35 api tests). **Live agent is wired in** via `api/src/liveRunSource.ts` (`RUN_SOURCE=live`, env-gated; drives the real WS4 machine, `TOOLS_BACKEND`/`LLM_BACKEND` defaults like the agent CLI). All 20 `case_pack` pages now populate with real agent runs; the UI renders live/error statuses, refetches the AnswerFile when a run completes, and handles both the live (nested `payload.explanation`) and fixture (flat) explanation event shapes. Capture tooling: `ui/scripts/screenshot.mjs` + `playwright-core` (cached chromium; on NixOS run under a lib-providing nix-shell).
- WS7 `eval/`: **NOT STARTED** — `eval/` stub, `cases/` doesn't exist, Makefile `run-case`/`run-all`/`validate-answers` are stubs (D1/D3 unmet).
- WS8 `submission/`: **NOT STARTED** — directory doesn't exist.
- Real-time vs static: **PRD §2 makes real-time streaming a NON-GOAL.** Data is the static IEEE-CIS `data/*.csv`. The SSE stream is agent-**event** streaming of a fixture/replay run, not live transaction data — nothing to build there.

## Ollama LLM: working locally (2026-09-19)

- Found installed (Nix store, `ollama 0.30.5` — not on PATH, not running), started `ollama serve` on `:11434`.
- Pulled `qwen2.5:1.5b` (~1 GB) as the local model; set `OLLAMA_MODEL=qwen2.5:1.5b` in `.env` (gitignored — not committed).
- Cloud models (gemma4:31b, gpt-oss:120b/20b, nemotron-3-*) shown in the Claude desktop Ollama usage dialog: attempted, but the running binary treats them as local-registry names via `/api/chat` (404 / hangs) — signed-in cloud routing isn't usable through the code path the agent uses. **Stick with local `qwen2.5:1.5b`.**
- Fixed two related bugs in `291375f`: `agent/src/llm.ts` now honors `OLLAMA_HOST` (repo convention; `.env` defines `OLLAMA_HOST`, but the client read `OLLAMA_URL`, so real non-mock runs silently defaulted to `llama3.1`), and `api/src/env.ts` now strips inline comments (e.g. `TOOLS_BACKEND=fake # fake | real`) instead of including them in the parsed value.
- Verified end to end: a real Ollama-driven agent run completes — `HHG-920`, risk_score trigger, 32 events, 7 tool calls, verdict `fraud` / pattern `card_testing`, final state `done`.

## Full real dataset loaded (2026-09-19)

`pnpm --filter @hhgoa/graph prepare-load` (no `--max-transactions`) produced the full `graph/build/*.csv` (590,742 txns, 5,565 closed cases, 20 case-pack); `pnpm verify` dropped, redeployed, and loaded it (~6 min) — **every vertex/edge count matches** including `FLAGGED_TXN 20/20`; `mcp:smoke` passes against the running tigergraph-mcp server. `make verify-graph` is green on the REAL data.

## WS2 done and merged; WS4 real-tools switch wired (2026-09-19)

WS2 (`gsql/`) was completed on branch `ws2-gsql` (see `docs/todo.md`/`docs/decisions.md` for the full build — all 10 contract queries + 5 detectors + 4 algorithms + discovery, `make verify-gsql` green, 44/44 tests), then merged into `main` (fast-forward `a6b181d..f5718a4`) and pushed.

With WS2 in `main`, `agent/src/agentFactory.ts`'s `TOOLS_BACKEND=real` throw (previously citing "WS1/WS3 services not up yet") was unblocked and wired for real: `agent/src/mcpClient.ts`'s `RealMcpClient` now correctly calls the live `tigergraph__run_installed_query` MCP tool (the previous version called MCP tools by contract name and parsed responses as bare JSON — both wrong against the live server, confirmed by probing it directly) and transforms each WS2 query's raw output into the exact contract shape. `agentFactory.ts`'s `createToolProviders("real")` now wires WS3's real RAG runtime (`@hhgoa/rag`) plus a new in-memory case ledger (`agent/src/caseLedger.ts`). `graph/mcp-server/` (the tigergraph-mcp Python venv, previously only existing in a disposable worktree) was rebuilt properly in the main tree and its `venv/` added to `.gitignore` (it had no ignore rule before — a real risk). Verified with a full real run against the live graph on HHG-001's actual trigger, not just a typecheck — reached a coherent `escalated`/`card_testing`/`0.89` result with genuinely real evidence. Full detail, including two real bugs caught live (a case-id wiring bug, a sentinel-device ring-size issue), in `docs/decisions.md` and `docs/logs.md`'s 2026-09-19 entries.

`make test` green across all 9 workspace packages (367 tests), no regressions.

## Current state (2026-09-23 — supersedes the dated sections above, which are history)

**Stack as running now**
- LLM: local llama.cpp `llama-server`, **Qwen2.5-7B-Instruct Q4_K_M**, `-ngl 99 -c 16384 --load-mode none
  --cache-ram 0` (`/tmp/hhgoa-run/llama.sh`). `--cache-ram 0` is load-bearing: the default 8 GiB host
  prompt cache starved TigerGraph (iteration 12 postflight failure). Assessor calls are temperature 0 +
  JSON-schema constrained; the 7B's pattern pick is still sensitive to small input-text changes.
- Graph: TigerGraph CE 4.3.0-rc1 (docker `hhgoa-tigergraph`, REST :9000), full real load, all GSQL
  queries installed (`pnpm --filter @hhgoa/gsql install-queries`). `get_entity_profile` txn branch now
  returns `ts`; `community_lookup` returns `n_cases` + `population_confirmed_fraud_rate`.
- RAG: similarity scored in TigerGraph `vector_search` when `RAG_VECTOR_BACKEND=tigergraph` (29
  PolicyChunk + 5,565 FraudCase embeddings synced via `pnpm --filter @hhgoa/rag sync-graph`).
- Pattern scorer: **Jev** (TypeSafe hosted, `PATTERN_SCORER=jev`, key in `.env`) re-splits the documented
  pattern mass; the LLM still owns fraud-vs-legitimate and writes every narrative. Kev (local) is wired
  but untrained; its export (`.cache/kev/`) stopped at 1,419/1,584 train states.
- Code guards after the assessor: `patternRules.ts` (New device ⇒ pattern 3), `singleSignal.ts` (R1:
  one independent fraud signal ⇒ fraud mass capped at 0.69 so verification precedes any block).

**Measured (backtest on closed cases, leak-free replay at opened_at)**
- Iteration 17, 20 cases: patterns 10/17 = 58.8%, 0 FN, cleared escalated 1/3.
- Iteration 17, 50 cases: patterns 32/42 = 76.2% (22/25 on the 30 not iterated on), 0 FN,
  cleared 4/8 escalated / 3/8 blocked. Chain scripts and logs: `/tmp/hhgoa-run/chain_iter*.sh|log`,
  scorer `/tmp/hhgoa-run/score.py`.
- Confound to remember: in the history every dispute is confirmed fraud and (nearly) every model alert
  is cleared, so the backtest cannot exercise "model alert that is fraud"; fixes must never key on
  trigger kind.

**In flight / next**
1. Gap analysis by three read-only subagents (cleared alerts, pattern misses, undocumented) →
   implement → tests → one 50-case run (`docs/logs.md`, "Gap analysis dispatched").
2. Regenerate the 20 benchmark answers with the final setup; `make validate-answers`.
3. Refresh `submission/BLOG_POST.md` + `demo_script.md`; demo video and social post outstanding.
4. Working tree has many uncommitted changes (and the root `README.md` deleted — not by Claude);
   commit when the user asks.

**Operational rules**: clear `GRAPH-HHG-*` FraudCase vertices before a graded benchmark pass;
`make verify-graph` drops everything, so `make verify-gsql`/install-queries must follow it; never
start a measurement run while changes are still landing; preflight needs MemAvailable ≥ 3 GB.
