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

## Now (STEP 2 — WS1-WS6 merged, remaining workstreams)

The four parallel implementation workstreams (WS1 `graph/`, WS3 `rag/`, WS4+WS5 `agent/`+`policy/`, WS6 `api/`+`ui/`) were reviewed against PRD §16 and merged into `main`. `make test` is green (9/9 tasks: contracts 83, agent 71, policy 54, api 20, rag 95), typecheck clean across TS packages, and `make verify-graph` passes against the running CE container. This merge included: restoring `api/src/data/casePack.ts` (`82fe080`, it was swallowed by the broad `data/` gitignore rule) and reconciling the ws3 test suite to the contract-correct rag API (`7334b93`).

- [x] WS1 (graph/) merged — schema + queries + `make verify-graph` wiring, fast-forwarded into `main`.
- [x] WS3 (rag/) merged — `cb50f0e`, merged via `9ffa53f` (pnpm-lock resolved with `--theirs` + `pnpm install --lockfile-only`).
- [x] WS4+WS5 (agent/ + policy/) merged — `fab1533`, merged via `be642c6`, tests 71+54 green.
- [x] WS6 (api/ + ui/) merged — `d53947b`, merged via `881c889`, api tests 20 green (`casePack.ts` restored after the gitignore swallow).
- [x] One full `pnpm install` after the merges (needed to create `@hhgoa/*` workspace symlinks).
- [x] WS3 rag suite reconciled (`7334b93`) — 95/95 green (was 12 failing / 21 TS errors from test drift vs the contract-correct implementation).
- [x] `make test` 9/9 tasks green; `make lint`+`typecheck` clean; `make verify-graph` passes.
- [ ] WS2 (gsql/) — PRD's recommended grouping runs it after WS1 in the same track, and it needs WS1's `schema.gsql`. **WS1's schema is now merged; WS2 is the unblocked next workstream.** It owns `gsql/`, which is outside the already-merged workstreams' boundaries.
- [ ] WS7 (eval/) — once WS4 emits real events.
- [ ] WS8 (submission/) — continuous per PRD §17.
- [ ] TigerGraph MCP: the Python-exception decision and WS1's container-based `tigergraph-mcp` setup are done; confirm the running MCP server + TS-side client (`@modelcontextprotocol/sdk`) together end to end.
- [ ] Optional hardening (not urgent, localhost-only): change default `tigergraph` password via `gsql ALTER PASSWORD tigergraph` before any non-local exposure.
- [ ] Ollama: add service to `docker-compose.yml`, pull a small free model, set `OLLAMA_MODEL` — was deferred to WS4; still not running.

## Standing reminders (don't re-litigate)

- OpenCode delegation is paused — Claude Code implements directly until reintroduced (see `docs/decisions.md`).
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
