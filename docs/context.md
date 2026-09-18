# Project context (read this first if picking up cold)

Hackathon project: an agentic fraud-investigation system on TigerGraph (IEEE-CIS-derived
bank dataset). Full spec is `PRD.md`; the dataset's own rules/schema/policy/answer format
are in `README.md` (authoritative — `PRD.md` and `docs/DATA_MAP.md` are reconciled against
it, never the other way around).

## Repo

- Private GitHub repo: https://github.com/Ansh-Sonkusare/hhgoa-fraud-agent
- Branch: `main`. No feature branches yet — still solo on WS0.
- Raw dataset CSVs (`transactions.csv`, `identity.csv`, `closed_cases_history.csv`,
  `case_pack.csv`) live in `data/`, which is gitignored. Never commit them.

## Tooling (changed from PRD's original wording — see `docs/decisions.md`)

- pnpm workspaces + Turborepo, not plain npm workspaces. `pnpm-workspace.yaml` lists the
  packages; `turbo.json` defines the task graph (`build`, `test`, `lint`, `typecheck`).
  `packageManager` is pinned in root `package.json` so corepack resolves a consistent pnpm.
- Node 20+, TypeScript strict mode, `tsx` for dev, `zod` for validation, `vitest` for tests.
- `Makefile` is a thin wrapper: `make test`, `make lint`, `make verify-graph`,
  `make run-case CASE=<id>`, `make run-all`, `make validate-answers`. Targets not yet owned
  by a finished workstream print a "not implemented yet" message and exit 0 rather than
  failing the build.

## Status (update as workstreams land)

- **WS0 (contracts and skeleton)**: in progress. Root skeleton, `contracts/src/*` (zod
  schemas + types for `AnswerFile`, tool envelope, `EvidenceItem`, `AgentEvent`,
  `Assessment`, tool catalog, policy contracts), 26 tool fakes + example JSON fixtures done.
  `fixtures/` (2 recorded case runs) and `tests/ws0/` vitest suite were being written in
  parallel by forked subagents as of the last update to this file — check `docs/logs.md`
  for the latest before assuming they've landed.
- **WS1-WS8**: not started. See PRD §16 for ownership and §19.3 for kickoff prompts.

## Agent workflow note

`CLAUDE.md` briefly described a Claude-plans/OpenCode-implements split; that's paused (see
`docs/decisions.md`) because the OpenCode MCP integration was unreliable this session
(model-auth errors across every OpenAI-provider model, then the MCP server itself
disconnected). Claude Code is implementing directly for now. Resume OpenCode delegation
later if the user asks — don't reintroduce it unprompted.

## Where to look next

- `docs/todo.md` — the live checklist.
- `docs/decisions.md` — judgment calls made and why, so they aren't re-litigated by accident.
- `docs/logs.md` — dated append-only log of what happened this session.
- `docs/REQUESTS.md` — cross-workstream asks (empty so far).
- `docs/MCP_TOOLS.md` — placeholder table WS1 fills in once TigerGraph MCP is connected.
