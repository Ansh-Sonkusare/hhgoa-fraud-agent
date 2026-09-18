# Live TODO

Check items off as they land; keep this in sync with reality, not aspiration. Detailed
per-workstream definition-of-done lives in PRD §16 — this file is the short, immediate list.

## STEP 0 — repo setup

- [x] `git init`, `.gitignore` (node_modules/, data/, .env, *.csv)
- [x] Initial commit (PRD, README, CLAUDE.md, docs/)
- [x] Private GitHub repo created and pushed (`gh repo create --private`)

## STEP 1 — WS0 (contracts and skeleton)

- [x] Root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- [x] Placeholder `package.json` for each other workstream dir (graph/, gsql/, rag/,
      agent/, policy/, api/, ui/, eval/) so the workspace resolves
- [x] `Makefile`, `.env.example`
- [x] `contracts/src/`: toolEnvelope, evidenceItem, state, agentEvent, assessment,
      answerFile (with README cross-field rules as zod refinements), policy, tools
      (26-tool catalog signatures), fakes (all 26 implemented), index barrel
- [x] `contracts/examples/*.json` — one per tool (26 files), realistic fake IDs
- [ ] `fixtures/` — 2 recorded case runs (clear-fraud, ambiguous) — **in progress**
      (forked subagent; verify output before trusting it landed)
- [ ] `tests/ws0/` — vitest suite covering all schemas, cross-field rules, fakes,
      fixtures — **in progress** (forked subagent; verify before trusting)
- [ ] `pnpm install` at root, confirm `pnpm --filter @hhgoa/contracts test` /
      `make test-contracts` green
- [ ] `npx tsc --noEmit` (or `pnpm --filter @hhgoa/contracts typecheck`) clean
- [ ] Review both forked subagents' diffs by hand before committing
- [ ] Commit remaining WS0 work in small chunks (already committed: root skeleton pieces
      as they were written — check `git log` rather than assume)
- [ ] Tag `m0` once `make test-contracts` is green, push tags
- [ ] Report WS0 done per PRD §16's acceptance criteria

## STEP 2 — WS1-WS6 in parallel (after m0)

Not started. Use `git worktree add` per PRD §19.1, one branch per workstream, kickoff
prompts from PRD §19.3. Re-check PRD §19.4: subagents for read-only exploration inside a
session, not for writing across workstream boundaries; a fresh review pass checks each
merged workstream against PRD §16 before it's marked done.

## Standing reminders

- Never invent a field not in `README.md` or `docs/DATA_MAP.md`.
- `contracts/` is frozen after `m0` — changes after that need explicit human OK.
- Every graph/RAG/memory tool takes `as_of` (PRD §8.1) — already encoded in
  `contracts/src/tools.ts`'s signatures; don't relax this when real implementations land.
- No CSVs, no `data/`, no secrets committed — check `git status` before every commit.
