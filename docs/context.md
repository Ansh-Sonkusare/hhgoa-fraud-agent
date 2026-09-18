# Project context (living snapshot)

Read this first when resuming work — it's the fastest way back up to speed. Update it whenever the state below goes stale; don't let it drift.

## What this project is

TigerGraph Hacker House Goa hackathon: an agentic fraud-investigation system over an IEEE-CIS-derived card-transaction dataset. Full spec lives in `PRD.md` (binding plan) and `README.md` (binding dataset/answer-format/policy — README wins on any disagreement). `docs/DATA_MAP.md` reconciles the two.

## Repo state

- Private GitHub repo: `Ansh-Sonkusare/hhgoa-fraud-agent`, branch `main`, pushed.
- Raw dataset CSVs live in `data/` (gitignored) — never commit them.
- Stack: TypeScript end to end, Node 20+, **pnpm workspaces + Turborepo** (switched from npm workspaces per user instruction — see `docs/decisions.md`), `tsx`, `zod`, `vitest`. No Python except `.gsql` files.
- **WS0 is functionally complete and green** (`make test-contracts`: 83/83 passing; typecheck clean) — what's left is committing it in reviewed chunks and tagging `m0` before starting WS1-WS6 in parallel per PRD §16/§19.

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

## Next steps

1. Commit WS0 in reviewed chunks, tag `m0`, push tags, report STEP 1 done.
2. Move to STEP 2 (WS1-WS6 kickoffs per PRD §19.3) once m0 is confirmed.
