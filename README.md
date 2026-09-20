# hhgoa-fraud-agent

Agentic fraud-investigation system for the TigerGraph Hacker House Goa challenge: an
LLM agent investigates card-fraud alerts over the IEEE-CIS-derived transaction dataset,
builds and progresses cases on a TigerGraph graph, files suspicious activity reports,
and recommends the next best action under the fraud policy.

This repository is a pnpm + Turborepo monorepo. TypeScript end to end; the only other
languages are GSQL (TigerGraph's query language) and a single, isolated Python venv for
the official `tigergraph-mcp` server.

## Authoritative documents

| Document | What it is |
|---|---|
| [`PRD.md`](./PRD.md) | The binding implementation plan (workstreams, milestones, definition of done) |
| [`docs/DATASET_README.md`](./docs/DATASET_README.md) | The binding dataset spec, known fraud patterns, fraud policy, and answer format. **Wins on any disagreement** |
| [`docs/DATA_MAP.md`](./docs/DATA_MAP.md) | Reconciled reference for files, columns, and patterns — read this instead of re-deriving from CSVs |
| [`docs/context.md`](./docs/context.md) | Living project snapshot; read first when resuming work |
| [`CLAUDE.md`](./CLAUDE.md) | Working rules for contributors and agents |

## Layout

Ownership boundaries are defined in PRD §6. Do not edit another workstream's directory.

| Path | Workstream | Contents |
|---|---|---|
| `contracts/` | WS0 | Frozen shared types, tool catalog, fakes (frozen after M0) |
| `graph/` | WS1 | TigerGraph schema, loading jobs, schema deploy / load / verify scripts, `mcp-server/` |
| `gsql/` | WS2 | Installed queries, pattern detectors, graph algorithms, discovery |
| `rag/` | WS3 | Retrieval and GraphRAG |
| `agent/` | WS4 | Investigation agent and orchestration |
| `policy/` | WS5 | Fraud policy and action/approval rules |
| `api/` + `ui/` | WS6 | HTTP API and front end |
| `eval/` + `cases/` | WS7 | Evaluation harness and case packs |
| `submission/` | WS8 | Submission assembly |
| `tests/` | all | Tests, one directory per workstream |

## Getting started

Requirements: Node 20+, pnpm 9 (`corepack enable`), and Docker (for TigerGraph CE
and the MCP server).

```bash
pnpm install

# bring up TigerGraph CE and the TigerGraph MCP server
make mcp-up
make mcp-down
```

Secrets and connection settings come from `.env` only (see `.env.example`). Raw dataset
CSVs live in `data/` and are gitignored — never commit them.

## Common commands

```bash
make test             # turbo run test (all workstreams)
make lint             # turbo run lint
make test-contracts   # contracts only
make verify-graph     # deploy schema + load + verify against the running container
make verify-gsql      # install WS2 queries + run the WS2 suite (idempotent)
make mcp-up           # start TigerGraph CE + MCP server
make mcp-down         # stop them

make run-case CASE=<id>  # benchmark one case (e.g. HHG-017)
make run-all             # benchmark all 20 cases
make validate-answers    # validate cases/*.json against the dataset
```

## Running the benchmark (WS7)

Prereqs: `pnpm install`, a filled `.env` from `.env.example`
(`TIGERGRAPH_*`, `TIGERGRAPH_MCP_URL`, `OLLAMA_MODEL` e.g. `qwen2.5:1.5b`), and the
raw CSVs present in `data/`.

```bash
# 1. Graph up and MCP server running (first TigerGraph boot takes several minutes)
make mcp-up

# 2. Build the load files from data/ and load the full graph
pnpm --filter @hhgoa/graph prepare-load   # data/*.csv -> graph/build/*.csv (derived ids)
pnpm --filter @hhgoa/graph load           # load into TigerGraph
pnpm --filter @hhgoa/graph verify         # vertex/edge count checks

# 3. Install the WS2 queries the agent calls through the MCP server (idempotent)
make verify-gsql

# 4. Run all 20 cases against the real graph + Ollama
make run-all            # answers -> cases/<id>.json, raw runs -> runs/<timestamp>/

# 5. Validate answers (dataset-id resolution + schema + cross-field rules)
make validate-answers   # PASS means 20/20

# single case / forced fresh rerun (runs replay from runs/ cache by default)
make run-case CASE=HHG-017
pnpm --filter @hhgoa/eval run-benchmark --no-cache --case HHG-017
```

Flags/env: `--backend fake|real`, `--llm mock|ollama`, `--timeout <seconds>`, `--plan-only`;
env `TOOLS_BACKEND`, `LLM_BACKEND`, `OLLAMA_MODEL`, `CASE_TIMEOUT_S` (default 900).

A standalone tree-sitter grammar and offline compiler/linter for this repo's GSQL
dialect lives in its own repository: [Ansh-Sonkusare/gsql-treesitter](https://github.com/Ansh-Sonkusare/gsql-treesitter).

## Rules

- `data/` and all raw CSVs are gitignored; never commit raw data.
- Secrets only via `.env`; never commit credentials.
- `contracts/` is frozen after milestone M0 — changes need explicit human approval.
- Every graph, RAG, and memory tool takes `as_of` and must ignore information after it.
- Tests live in `tests/<workstream>/`; do not write into another workstream's tests.