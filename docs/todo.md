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

## Next (STEP 2 — after m0)

- [ ] Kick off WS1 (graph/) per PRD §19.3 kickoff prompt.
- [ ] Kick off WS2 (gsql/) once WS1's schema draft exists.
- [ ] Kick off WS3 (rag/).
- [ ] Kick off WS4+WS5 (agent/ + policy/) against fakes.
- [ ] Kick off WS6 (api/ + ui/) against fixtures.
- [ ] WS7 (eval/) once WS4 emits real events.
- [ ] WS8 (submission/) continuous from day 1 onward per PRD §17.

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
