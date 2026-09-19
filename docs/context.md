# Project context (living snapshot)

Read this first when resuming work — it's the fastest way back up to speed. Update it whenever the state below goes stale; don't let it drift.

## What this project is

TigerGraph Hacker House Goa hackathon: an agentic fraud-investigation system over an IEEE-CIS-derived card-transaction dataset. Full spec lives in `PRD.md` (binding plan) and `README.md` (binding dataset/answer-format/policy — README wins on any disagreement). `docs/DATA_MAP.md` reconciles the two.

## Repo state

- Private GitHub repo: `Ansh-Sonkusare/hhgoa-fraud-agent`, branch `main`, pushed.
- Raw dataset CSVs live in `data/` (gitignored) — never commit them.
- Stack: TypeScript end to end, Node 20+, **pnpm workspaces + Turborepo** (switched from npm workspaces per user instruction — see `docs/decisions.md`), `tsx`, `zod`, `vitest`. The only non-TypeScript code is `.gsql` (WS1/WS2) and one narrow Python exception for the official `tigergraph-mcp` server — see `docs/decisions.md`.
- **All STEP-2 implementation workstreams are merged into `main` and green.** `make test` runs 9/9 tasks (contracts 83, agent 71, policy 54, api 20, rag 95 — all passing), typecheck is clean across contracts/rag/agent/policy/api, `make verify-graph` passes. WS0 tag `m0` exists.

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

Remaining known edges (non-blocking, tracked in `docs/todo.md`): WS2 `gsql/` (deliberately held back until WS1's schema landed — can now start), WS7 `eval/` (after WS4 emits real events), WS8 `submission/` (continuous). The `FLAGGED_TXN=0` smoke-verification finding (all flagged case ids fall outside the loaded smoke subset) was explained and deferred, not fixed.
