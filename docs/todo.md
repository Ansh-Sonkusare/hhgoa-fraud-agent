# Todo

Living task list. Check items off in place; don't delete history — move completed items to the "Done" section instead of erasing them, so this doubles as a lightweight record of what's actually finished.

## Now (WS0 — must land before m0)

- [x] `fixtures/case-run-ambiguous.json` — the fixtures fork only delivered `case-run-clear-fraud.json`; wrote the ambiguous one by hand (case `HHG-920`), same ID conventions.
- [x] `tests/ws0/*.test.ts` (6 files from the tests fork) + `tests/ws0/fixtures.test.ts` (written by hand — fixtures didn't exist yet when that fork ran) — covers all schemas, every `answerFile.ts` cross-field rule, all 26 fakes (envelope + `as_of` echo), both fixtures.
- [x] `pnpm install` at repo root.
- [x] `make test-contracts` green — 7 files, 83 tests passed.
- [x] `pnpm --filter @hhgoa/contracts typecheck` clean.
- [x] Reviewed both forks' unsolicited edits: `contracts/src/answerFile.ts` (`sar.file===true` requires non-empty `narrative` — correct, kept), `contracts/tsconfig.json` (`noEmit: true` — correct, kept), `contracts/vitest.config.ts` (new, needed — kept), root `package.json` (`"type": "module"` + hoisted devDeps — correct, kept). Restored `.env.example` to the fuller version after the fixtures fork trimmed it (see `docs/logs.md`).
- [ ] Commit WS0 work in small, reviewed chunks (not one giant commit) — in progress.
- [ ] Tag `m0`, push tags.
- [ ] Report STEP 1 done per PRD §16's WS0 acceptance criteria.

## Now (infra prep before STEP 2 kickoffs)

- [x] `.env` created from `.env.example` (gitignored, not committed).
- [x] Decision: TigerGraph via local Docker CE (`docker-compose.yml`, root), not Savanna — see `docs/decisions.md`.
- [x] Decision: LLM swapped to local Ollama (no API key), Groq wired as optional fallback — PRD §5/OQ7 updated in place, see `docs/decisions.md`.
- [x] TigerGraph CE running and verified: REST API (`/echo`) responds, GSQL shell authenticates (`tigergraph`/`tigergraph`), `.env` filled in with working `TIGERGRAPH_HOST`/`USERNAME`/`PASSWORD`. Image is `tigergraph/community:4.3.0-rc1`, loaded from the dl.tigergraph.com download (not pulled from a registry tag) — see `docs/decisions.md` for the full story including the failed Enterprise-image attempt.
- [ ] Ollama: skipped for now per user instruction — revisit at WS4 kickoff (add service back to `docker-compose.yml`, pull a small free model, set `OLLAMA_MODEL`).
- [ ] Optional hardening (not urgent, localhost-only): change default `tigergraph` password via `gsql ALTER PASSWORD tigergraph` before any non-local exposure.
- [ ] Flag to human before WS1 locks in MCP approach: official `tigergraph-mcp` server needs Python 3.10-3.12, conflicts with repo's "no Python" rule (see `docs/decisions.md`).

## Now (STEP 2 review — what's actually merged vs PRD §16 DoD)

The four parallel implementation workstreams (WS1 `graph/`, WS3 `rag/`, WS4+WS5 `agent/`+`policy/`, WS6 `api/`+`ui/`) were reviewed against PRD §16 and merged into `main`. `make test` is green (9/9 tasks: contracts 83, agent 71, policy 54, api 20, rag 95), typecheck clean across TS packages. **But a PRD recheck (2026-09-19) shows most DoD rows are only "merged & green on fakes/fixtures" — the real-tools wiring is largely NOT done.** Per-workstream reality:

- [x] WS0 (contracts/) — 83 tests green, fakes return valid envelopes, answer schema reconciled with README.
- [x] WS1 (graph/) — schema.gsql, loading jobs, 3 sample queries (`sample_txn_explain`/`sample_card_velocity`/`sample_link_analysis`) + `graph_stats` installed; `make verify-graph` passes; MCP server running and `mcp:smoke` (3 queries via MCP) works.
- [x] **WS1 full-dataset load (2026-09-19)** — `prepare-load` (no `--max-transactions`) + `verify` loaded the FULL real data (~590,742 txns, 5,565 closed cases, 20 case-pack); all vertex/edge counts match; **`FLAGGED_TXN 20/20` now matches** (resolves the deferred smoke finding); `mcp:smoke` green.
- [ ] **WS1 repro gap: `graph/mcp-server/` (tigergraph-mcp Python venv + its `.env`) is NOT tracked in main — it only exists in the leftover WS1 worktree under `.claude/` (gitignored).** `pnpm mcp:start` from a clean main clone would fail. Add a setup doc/script (venv build + `.env` wiring, per `docs/MCP_TOOLS.md`) before D1 (clean-clone run).
- [x] **WS2 (gsql/) DONE (branch `ws2-gsql`, worktree `/home/teak/code/wt-gsql`)** — all 19 `.gsql` files (10 contract queries, 5 detectors, 4 algorithms, discovery report) installed and passing against the live full-dataset graph. `make verify-gsql` wired into the root Makefile and green end to end (install all queries + run algorithms/discovery + `tests/ws2/*.test.ts`, 33/33 tests, 5 files). Verified idempotent against a simulated WS1 reset (`DROP QUERY ALL` + cleared discovered `Pattern`s, no data reload needed — full `make verify-graph` DROP-ALL-and-reload isn't runnable from this worktree since `graph/build/`/`data/` are gitignored and only exist in the main tree/checked out branch that produced them): `install.ts` fully self-heals. `docs/IDENTITY_VALIDATION.md` written (100% purity, 38.1% customer split rate, plus a not-yet-actioned improvement idea). WS1's own sample queries, which the idempotency test also dropped, were restored before finishing. Remaining real gap: `community_components.gsql`'s WCC leaves one large ~3,959-card residual component even after the hub-degree fix (documented, not chased further). See `docs/logs.md` for the full blow-by-blow and `docs/decisions.md` for the design calls made along the way.
- [x] WS3 (rag/) — 95 tests green; ingestPolicy/ingestCases read real `data/*.csv`; retrieve/contextBuilder (bundle ≤6k tokens)/memory implemented.
- [ ] **WS3 DoD "memory write visible in graph" NOT met** — `rag/src/store/vectorStore.ts` is a local adapter; graph-native vectorSearch expansion + write-back are blocked on WS1 vector queries / WS2 (open WS3→WS1 REQUESTS.md item, `Resolved:` blank).
- [x] WS4 (agent/) — state machine, MCP client wrapper, tool registry, assessor + confidence guard, VOI planner, explainer, prompts — 71 tests green against fakes.
- [ ] **WS4 DoD "real-tools switch works" NOT met** — `agent/src/agentFactory.ts` `TOOLS_BACKEND=real` throws ("WS1/WS3 services not up yet"). Default run = MockLlmClient + contracts fakes (deterministic "clear fraud" pass on examples data).
- [x] WS5 (policy/) — policy.yaml, engine, responders, approval channels (UI/Discord), mock actions, SAR — §10.5 tests green (54).
- [x] WS6 (api/ + ui/) — Fastify + SSE + full Next.js UI (case queue, case detail panels, approvals inbox — see `ui/screenshots/*.png`) — 20 api tests green.
- [ ] **WS6 DoD "runs from a real run" NOT met** — `api/src/runSource.ts` is `FixtureRunSource` only (replays `fixtures/*.json`); the live agent is not plugged into `RunSource` (straightforward seam: same interface, drive `agent/machine.ts`, gated by env). The 20 `case_pack` entries have no recordings today: their case pages open but show no timeline/evidence. Ad-hoc triggers return "no live agent connected."
- [ ] WS7 (eval/) NOT STARTED — `eval/` is a `package.json` stub; `cases/` doesn't exist; `Makefile` `run-case`/`run-all`/`validate-answers` are stubs. D3 (`make validate-answers` green) unmet.
- [ ] WS8 (submission/) NOT STARTED — `submission/` doesn't exist (demo script, blog, social draft).
- [ ] Real-time vs static: **PRD §2 lists "real-time streaming" as an explicit NON-GOAL.** Data is the static IEEE-CIS-derived `data/*.csv`. The SSE stream is agent-event streaming of a (fixture/replay) run, NOT live transaction data. Nothing to implement.
- [x] Ollama: installed & tested — `qwen2.5:1.5b` pulled, server running on `:11434`, `OLLAMA_MODEL` set in `.env`, full 32-event agent run driven end-to-end (291375f). Cloud models (gemma4:31b etc.) were attempted but the local binary 0.30.5 pulls them as local registry lookups and they're not usable via the `/api/chat` path — local small model works, stick with it. Also fixed `llm.ts` to read `OLLAMA_HOST` (repo convention) + env-loader inline-comment parsing.
- [ ] Optional hardening (not urgent, localhost-only): change default `tigergraph` password via `gsql ALTER PASSWORD tigergraph` before any non-local exposure.

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
