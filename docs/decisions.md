# Decisions log

One entry per decision that wasn't already dictated by `PRD.md`/`README.md`. Newest first. Each entry: what was decided, why, and what it overrides (if anything).

## 2026-09-18 — Monorepo tooling: pnpm workspaces + Turborepo, not npm workspaces

**Decided:** switch from npm workspaces (as originally written in PRD §5/§6/§19 and CLAUDE.md) to pnpm workspaces (`pnpm-workspace.yaml`) orchestrated by Turborepo (`turbo.json`).

**Why:** explicit user instruction mid-session, after WS0 root skeleton had already been drafted once with npm workspaces. User confirmed "pnpm workspaces + Turborepo" over "pnpm only" or "keep npm" when asked.

**What it overrides:** PRD.md §5, §6, §19.1, §19.3 (WS0 kickoff prompt) and CLAUDE.md's "Stack" section previously said "npm workspaces" explicitly — all updated in place to say "pnpm workspaces + Turborepo" so the docs and the actual repo don't diverge. Root `package.json` no longer has a `workspaces` field; package list lives in `pnpm-workspace.yaml`. Task orchestration (`test`, `lint`, etc.) goes through `turbo run <task>` instead of `npm run <task> --workspaces`.

## 2026-09-18 — OpenCode delegation paused; Claude Code implements directly

**Decided:** CLAUDE.md's "Agent Roles" section (added by the user directly, checked into the repo) originally specified Claude as architect/planner and OpenCode as the implementation/execution agent for all substantial code changes. After repeated OpenCode MCP failures this session (model-auth errors across every OpenAI-provider model tried, then the OpenCode MCP server itself disconnecting and its local `opencode serve` process becoming unreachable), the user instructed: change CLAUDE.md to not use OpenCode for now, Claude Code implements directly, reintroduce OpenCode later.

**Why:** OpenCode was unreliable in this environment at the time (auth + connectivity issues, not a fundamental rejection of the delegation model itself).

**What it overrides:** CLAUDE.md's "Agent Roles" and "Implementation Workflow" sections were rewritten to say Claude Code does reasoning, planning, editing, running commands, and verification directly, with OpenCode delegation explicitly marked as "planned but not active" rather than removed as a concept.

## 2026-09-18 — Fixture/example ID conventions

**Decided:** synthetic IDs in `contracts/examples/*.json` and `fixtures/*.json` use formats that match the real dataset's structure (confirmed by inspecting `data/*.csv` headers directly — plain numeric `TransactionID`, `C#####` customer ids, `C#####-K#` card ids, `CC-####` closed-case ids) but fall in numeric ranges clearly outside anything seen in the real files (e.g. transaction ids `"991xxxx"`/`"992xxxx"`, customers `"C0910x"`, closed cases `"CC-09xx"`), so nobody mistakes a fixture for a real dataset row or accidentally treats a fixture ID as resolvable against the real graph once it's loaded.

**Why:** initial draft used a `"T0900001"`-style prefix that doesn't match any real column (`TransactionID` is plain numeric) — caught by checking `data/transactions.csv`'s actual header/rows before finalizing WS0's examples.

## 2026-09-18 — `answerFile.ts`: SAR narrative required when `sar.file` is true

**Decided (observed, not authored by the main thread — a parallel background fork made this edit while working on `tests/ws0/`; reviewed and kept):** added a `superRefine` check that `sar.file === true` requires a non-empty `sar.narrative`.

**Why it's correct:** README's Answer Format table says `narrative` is "Required when `file` is true" — the original schema only encoded the inverse (`file === false` implies blank fields) and missed this direction. Keeping the fork's fix rather than reverting it.
