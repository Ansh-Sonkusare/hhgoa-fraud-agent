# Decisions log

One entry per decision that wasn't already dictated by `PRD.md`/`README.md`. Newest first. Each entry: what was decided, why, and what it overrides (if anything).

## 2026-09-18 — Python allowed, narrowly, for the official TigerGraph MCP server

**Decided:** relax the "no Python" stack rule specifically for installing/running `tigergraph-mcp` (https://github.com/tigergraph/tigergraph-mcp#installation) — the required hackathon component whose official implementation is Python-only. Per explicit user instruction: "i also dont want to fully commit to only ts i just prefferred it so if there is a way to do that easily in python we can use that... if we need the python we can use that." TypeScript-only was always a preference, not an inviolable constraint, and the user chose to relax it here specifically rather than have WS1 route around it.

**What this supersedes:** the earlier resolution in the TigerGraph MCP entry below said to run `tigergraph-mcp` as an external Docker process specifically to avoid any Python entering the repo. That workaround is no longer necessary — WS1 can install and run it directly per its own README (e.g. `pip`/`uv` install) if that's simpler than a Docker wrapper. The external-process option is still fine too; either is acceptable now.

**Scope — this is narrow, not a general stack reversal:** Python is allowed only for this one required third-party component, kept isolated to its own directory (e.g. a subfolder under `graph/`, its own venv/deps, not mixed into `agent/`/`policy/`/other TS application code). It is not a green light for Python anywhere else in the project — CLAUDE.md and PRD.md were both updated to state the exception narrowly, not removed wholesale. `graph/`'s TypeScript code still talks to the MCP server as a client (via `@modelcontextprotocol/sdk`, from `agent/`) regardless of what language the server itself is written in.

**What it overrides:** CLAUDE.md's "Stack" section ("No Python") and PRD.md's stack paragraph ("no Python anywhere") — both updated in place with this one named exception.

## 2026-09-18 — TigerGraph via local Docker Community Edition, not Savanna cloud

**Decided:** run TigerGraph Community Edition locally via `docker-compose.yml` (root, service `tigergraph`, image `tigergraph/tigergraph:latest`, ports 9000/14240/14022) instead of provisioning a Savanna cloud workspace, per explicit user instruction ("setup their docker images and compose... get creds yourself and fill it").

**Why:** Savanna requires a human to sign up for a TigerGraph Cloud account — not something Claude Code can self-serve. Docker CE needs no external account, so credentials/setup can be handled end-to-end in-session.

**Caveat surfaced to the user before proceeding:** TigerGraph's own docs state a minimum of 16GB RAM / 4 CPUs for CE (20GB/8 CPUs recommended). This machine has 15GB total RAM. User chose to proceed anyway (stopped two unrelated containers, `spiderman-postgres`/`spiderman-redis`, to free memory — they can be restarted with `docker start spiderman-postgres spiderman-redis`). If TigerGraph is unstable under this load, the fallback is Savanna, which needs the user to hand over real workspace credentials.

**What it overrides:** PRD §18.1 listed Savanna as the primary option (OQ5 called both "either works"); Docker CE is now the one actually running for this project.

**Resolution / how it actually ended up running:** the public `tigergraph/community:latest` tag isn't pullable directly — the real path is signing up at dl.tigergraph.com for a CE download link (user did this, forwarded the emailed link), `curl`-downloading the ~2.6GB `tigergraph-4.3.0-rc1-community-docker-image.tar.gz`, `docker load`-ing it (produces local tag `tigergraph/community:4.3.0-rc1`), then `docker compose up -d`. An earlier attempt with `tigergraph/tigergraph:latest` (the licensed Enterprise image) got stuck in permanent `Warmup` for GPE/GSE/RESTPP because of `License expired: Thu Jan 1 00:00:00 1970` — that image needs a real license key we don't have, hence the switch to Community Edition. Confirmed working: REST API (`curl http://localhost:9000/echo` → `{"error":false,"message":"Hello GSQL"}`) and GSQL shell (`gsql -u tigergraph -p tigergraph`) both respond with the CE image's default credentials `tigergraph`/`tigergraph` (Linux user and DB superuser both use this password out of the box — TigerGraph's own docs flag this as needing to change before any non-local exposure; left as-is for now since this only binds to localhost). `docker-compose.yml` volume mounts the whole `/home/tigergraph` home dir (matching TigerGraph's own docs) so the loaded schema/data survives container restarts. GPE/GSE report `Warmup` (not `Online`) at idle — this is expected with no graph schema created yet (`Can not refresh graph schema successfully, rc: Empty Content` in their logs is benign, not a crash), and should resolve once WS1 creates the `hhgoa_fraud` graph.

## 2026-09-18 — LLM: local Ollama instead of Claude/`@anthropic-ai/sdk`

**Decided:** swap the agent's reasoning/tool-selection/explanation LLM from Claude (`@anthropic-ai/sdk`, as PRD §5/OQ7 originally specified) to a local Ollama model, run via Docker, using `LLM_BACKEND=ollama` in `.env`. Groq was considered (also free) but not chosen as the default.

**Why:** explicit user instruction — no `ANTHROPIC_API_KEY` available, and "skip anthropic and other stuff." Between the two free alternatives offered (Ollama, Groq), Ollama was picked as the default because it needs zero external account or API key — fully self-serviceable via `docker compose up`. Groq's free tier still requires a human to sign up for an API key, so it's left wired as an optional fallback (`LLM_BACKEND=groq`, `GROQ_API_KEY` in `.env.example`) rather than the default.

**What it overrides:** PRD §5 (Stack paragraph) and OQ7 (§0 table) both said "Claude via `@anthropic-ai/sdk`" — both updated in place. `contracts/` is unaffected (no LLM-specific types live there), so this does not touch the frozen `m0` contracts.

**Resolved (supersedes this item as originally logged):** TigerGraph MCP (`https://github.com/tigergraph/tigergraph-mcp`) is a **required component** of the hackathon brief, not optional — confirmed directly from `TigerGraph Agentic Fraud Investigation HHGOA.md` (the original brief, present at repo root — read in full to cross-check PRD.md against it), section "What Participants Build With" → "Required components", item 3: "TigerGraph MCP — Use TigerGraph MCP to expose graph capabilities and data to the agent." (GSQL/algorithms, GraphRAG, and the UI are also required components per the same list — all three already match what WS1/WS2/WS3/WS6 were briefed with, no further corrections needed there. The dataset's "before any additional evidence is requested / after any additional evidence is received" next-best-action recording requirement, from the brief's "Submissions" section, is also already captured — `contracts/src/answerFile.ts` and WS7's planned `validateAnswers.ts` check "initial/final next_best_actions" per PRD §16.) Bypassing it with a plain TS REST client (WS1's initial default, given before this was known) does not satisfy the brief. The official server is Python 3.10-3.12 (`pyTigerGraph`-based), which still conflicts with CLAUDE.md's "no Python" rule if committed into this repo — resolved by scope, not by exception: CLAUDE.md's "no Python" governs code *written and committed in this repository*, not third-party services the repo calls. The same precedent already applies to TigerGraph itself (runs as a Docker container, not TS we wrote) and to the `gsql` CLI (a foreign binary invoked via `docker exec`/subprocess). `tigergraph-mcp` follows the same pattern: run it as an **external process** (its own Docker container or subprocess, no `.py` files added to this repo), and `agent/`'s TypeScript code connects to it as a genuine MCP *client* using `@modelcontextprotocol/sdk`'s client APIs over whatever transport the server exposes (stdio or HTTP/SSE). WS1 was redirected from its original REST-bypass default to this approach mid-run (see `docs/logs.md`).

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
