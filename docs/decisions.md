# Decisions

Judgment calls made where the brief/PRD/README were silent or ambiguous, and why, so they
aren't accidentally re-litigated or reversed without noticing.

## Monorepo tooling: pnpm workspaces + Turborepo, not npm workspaces

PRD.md originally specified plain npm workspaces throughout (§5, §6, §19.2, §19.3). The
user asked mid-session to use "at least pnpm-workspaces", and on being asked whether that
meant pnpm alone or pnpm+Turborepo, chose pnpm+Turborepo. `PRD.md` and `CLAUDE.md` were
updated in place to say pnpm/Turborepo wherever they previously said npm workspaces, so
there's no drift between the doc and the actual root `package.json` /
`pnpm-workspace.yaml` / `turbo.json`. Root `package.json` no longer has a `workspaces`
field (that's npm's mechanism); `pnpm-workspace.yaml` is the source of truth for which
directories are packages, and `turbo.json` defines the `build`/`test`/`lint`/`typecheck`
task graph. `packageManager` is pinned in root `package.json` so corepack resolves a
consistent pnpm version regardless of what's globally installed.

## OpenCode delegation paused (CLAUDE.md "Agent Roles")

The user's `CLAUDE.md` edit introduced a Claude-plans/OpenCode-implements split. In
practice, every OpenAI-provider model available through the OpenCode MCP server rejected
with "not supported when using Codex with a ChatGPT account" (the configured credential is
a ChatGPT/Codex OAuth login, which only serves a narrow allowlist of OAuth-tagged models,
not the full model list `opencode_provider_models` advertises). Switching to other
providers (`kiro`/`qwen3-coder-next`, then `opencode`/`big-pickle`) ran into the MCP server
itself disconnecting mid-dispatch, and after a reconnect, a submission with an ambiguous
("unknown") outcome that the tool's own guidance says not to blindly retry. Rather than
keep burning turns on a flaky integration, asked the user, who said to implement directly
for now. `CLAUDE.md`'s "Agent Roles" and "Implementation Workflow" sections were rewritten
to say so explicitly. This is a pause, not a reversal — re-enable OpenCode delegation later
if asked, but don't reintroduce it unprompted just because the server reconnects.

## Fake/fixture ID ranges reserved to avoid confusion with real dataset rows

Real transaction IDs observed in `data/case_pack.csv` and `data/transactions.csv` are plain
numeric strings starting around `3000001` and running up to roughly `3590000` (per the 20
benchmark cases and the sampled rows). `contracts/examples/*.json` and (later) `fixtures/`
use transaction IDs in the `9900000`+ / `9910000`+ ranges specifically so nobody mistakes a
fake example for a real dataset row while skimming a diff. Card IDs (`C09001-K1` style),
customer IDs (`C09001`), and closed-case IDs (`CC-0910` style) follow the real dataset's
formats exactly (confirmed against `data/closed_cases_history.csv` and `data/case_pack.csv`
headers/sample rows) — only the specific numbers are picked to be obviously out of the
real range.

## `via` field choices in `contracts/src/fakes.ts`

The tool-result envelope's `via` enum (PRD §8.2) is `mcp|local|rag|policy`. Assignment per
tool group, since PRD doesn't spell this out per-tool:
- Graph tools (`resolve_trigger` through `find_prior_cases`) → `mcp` (they'll go through
  TigerGraph MCP once real).
- `get_wide_features` (local DuckDB) and `lookup_external` (mock/static enrichment) →
  `local`.
- `retrieve_policy`, `retrieve_similar_cases` → `rag`.
- All `case_*` tools → `local` (the agent's own case-log layer, which then persists to the
  graph as memory — the write path itself, not a read via MCP).
- `policy_check`, `execute_action`, `request_evidence`, `generate_sar` → `policy`.

## Tools without `as_of`

PRD §8.1 says "every graph, RAG, and memory tool takes `as_of`" — read literally against
the actual catalog in §8.4, three tools are exempt because they aren't time-travel-sensitive
reads of dataset/graph/memory content: `get_wide_features` (local DuckDB lookup by
already-known txn IDs), `retrieve_policy` (static policy/regulatory text, not time-varying),
and `lookup_external` (external/mock enrichment, real-time by nature). `policy_check`,
`execute_action`, `request_evidence`, `generate_sar` are policy/action tools, not
graph/RAG/memory reads, so they're exempt too. This matches the exact function signatures
given in PRD §8.4 (`retrieve_policy(query, pattern_id?, k)` has no `as_of` there, while
`retrieve_similar_cases(fingerprint, as_of, k)` does) — `contracts/src/tools.ts` mirrors
this precisely rather than adding `as_of` everywhere "to be safe."
