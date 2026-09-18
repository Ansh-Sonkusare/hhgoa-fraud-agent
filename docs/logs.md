# Session log

Append-only, most recent last. Dates/times are approximate (session-relative), meant to
give a future reader the sequence of events, not a precise audit trail.

- Read `CLAUDE.md`, `PRD.md`, `README.md`, `docs/DATA_MAP.md` in full before any action, per
  the task's STEP 0 instructions.
- `git init`, branch renamed to `main`, moved the four dataset CSVs (`transactions.csv`,
  `identity.csv`, `closed_cases_history.csv`, `case_pack.csv`) from repo root into gitignored
  `data/` (they were sitting at the root, not yet under `data/`).
- Wrote `.gitignore` (node_modules/, data/, .env, *.csv, build artifacts).
- First commit: PRD.md, README.md, CLAUDE.md, docs/ scaffolding, the original brief markdown.
- `gh repo create --private --source=. --remote=origin` → private repo created; `gh auth
  setup-git` failed (global git config is read-only in this sandbox), worked around with a
  repo-local `credential.helper` shelling out to `gh auth token`. Pushed `main`.
- User updated `CLAUDE.md` mid-session to add an "Agent Roles" section: Claude
  plans/reviews, OpenCode implements. Attempted to dispatch WS0 to OpenCode via its MCP
  tools.
- OpenCode dispatch failures, in order: `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.2-codex`
  (all OpenAI-provider models) rejected with "not supported when using Codex with a ChatGPT
  account" — the configured OpenAI credential is a ChatGPT/Codex OAuth login, not a
  standard API key, so it only serves a narrow OAuth-tagged model list. Switched to
  `kiro`/`qwen3-coder-next` — the MCP server itself then disconnected mid-dispatch. User
  redirected to `opencode`/`big-pickle`; that also hit the disconnect. After the user
  restarted the server (`/mcp` → "Reconnected to opencode"), refired once more but the
  submission outcome came back `unknown` (a genuine ambiguous-state case per the tool's own
  guidance: don't blindly retry, check first) and the underlying `opencode serve` process
  was unreachable on recheck. Rather than guess, asked the user how to proceed.
- User decided: drop OpenCode delegation for now, implement directly. Edited `CLAUDE.md`'s
  "Agent Roles" and "Implementation Workflow" sections accordingly (see
  `docs/decisions.md`). Committed and pushed.
- Began WS0 directly: root `package.json` (initially npm workspaces per PRD's original
  wording), `tsconfig.base.json`, placeholder `package.json` for graph/gsql/rag/agent/
  policy/api/ui/eval.
- User asked (mid-turn) to use pnpm workspaces + Turborepo instead of npm workspaces "at
  least". Confirmed scope via AskUserQuestion (user picked pnpm + Turborepo, not just
  pnpm). Updated `PRD.md` (§5, §6, §19.2, §19.3 kickoff prompt) and `CLAUDE.md` to say
  pnpm/Turborepo instead of npm workspaces; added `pnpm-workspace.yaml`, `turbo.json`;
  rewrote root `package.json` to drop the `workspaces` field and use `turbo run` scripts;
  added `.turbo/` to `.gitignore`.
- Wrote `contracts/src/`: `toolEnvelope.ts`, `evidenceItem.ts`, `state.ts`, `agentEvent.ts`,
  `assessment.ts`, `answerFile.ts` (README Answer Format schema + cross-field
  `.superRefine()` rules), `policy.ts`, `tools.ts` (26-tool catalog signatures per PRD
  §8.4, `as_of` on every graph/RAG/memory tool per §8.1), `fakes.ts` (in-memory
  implementation of all 26 tools, reading `contracts/examples/*.json`), `index.ts` barrel.
- Wrote all 26 `contracts/examples/*.json` fixtures.
- User asked to peek at the real CSVs for ID-format realism, maintain
  context/todo/logs/decisions docs, and parallelize the remaining work. Checked
  `data/transactions.csv`, `identity.csv`, `closed_cases_history.csv`, `case_pack.csv`
  headers + sample rows: confirmed transaction IDs are plain numeric strings (e.g.
  `"3514030"`), not the `T09xxxxx` style used in an earlier delegation draft prompt — fixed
  the 4 example files that had used that style (`sed` replace to `"9900001"`..`"9900004"`,
  a range clearly outside the real dataset's observed ID space so it can't be mistaken for
  a real row).
- Ran `pnpm install` at the root (confirms workspace resolves cleanly; corepack pinned
  pnpm to the `packageManager` field's version).
- Wrote `Makefile` (thin wrapper over `pnpm`/`turbo`, non-implemented targets exit 0 with a
  message) and `.env.example` (TOOLS_BACKEND, agent budgets, Anthropic key, TigerGraph
  connection vars, MCP URL, API/UI ports, optional Discord approval webhook, embeddings
  model).
- Forked two subagents in parallel: one writing `tests/ws0/` (vitest suite covering all
  schemas, cross-field rules, and the 26 fakes), one writing `fixtures/` (2 recorded case
  runs: clear-fraud and ambiguous-with-evidence-request). Both run against the
  already-written `contracts/src/` and `contracts/examples/`; briefed not to touch other
  directories. Started writing `docs/context.md`, `docs/todo.md`, `docs/logs.md`,
  `docs/decisions.md` while they run.
- Observed (via file-change notifications) that the tests fork made a legitimate fix to
  `contracts/src/answerFile.ts`: added a `sar.file === true` → `sar.narrative` non-empty
  check, which README's Answer Format actually requires ("narrative ... Required when
  `file` is true") and which the original draft had missed. Left as-is — correct per spec.
