# MCP tool names

Owned by WS1. The TigerGraph MCP server (https://github.com/tigergraph/tigergraph-mcp, official `tigergraph-mcp`) exposes every graph capability through `tigergraph__*` tools. WS1's agent-facing contract tools (PRD §8.4) map onto them below.

Start the server (recommended): `make mcp-up` — builds and starts both the TigerGraph container and the MCP server as the root `docker-compose.yml`'s `tigergraph` and `mcp-server` services (the latter built from `graph/mcp-server/Dockerfile`; `make mcp-down` stops both). No `.env` file or Python setup needed — config is in `docker-compose.yml`'s `environment:` block. Streamable HTTP is published on `127.0.0.1:8000`; connect at `http://127.0.0.1:8000/mcp/` (trailing slash required). `graph/scripts/mcpSmoke.ts` runs the 3 WS1 sample queries through it; that is what `make verify-graph` invokes (note: `verify-graph` does not itself run `mcp-up` — start the containers first). Neither path auto-restarts on a crash (compose sets `restart: unless-stopped`, which covers a container crash but not the Docker daemon going down) — `agent/src/mcpClient.ts`'s `RealMcpClient` (`TOOLS_BACKEND=real`) connects to whatever's already listening on `TIGERGRAPH_MCP_URL` (default `http://127.0.0.1:8000/mcp/`; this falls back with `||`, not `??`, because `.env.example` ships `TIGERGRAPH_MCP_URL=` empty and an empty string isn't `undefined` — the API, which loads `.env`, needs the same default).

Native fallback (no Docker): `pnpm --filter @hhgoa/graph mcp:start` runs the same server directly from a local Python venv (per CLAUDE.md's Stack section: isolated under `graph/mcp-server/`, never committed — `venv/` and `.env` are both gitignored). One-time setup:
```
cd graph
python3 -m venv mcp-server/venv
./mcp-server/venv/bin/pip install tigergraph-mcp
cp mcp-server/.env.example mcp-server/.env   # or write it: TG_HOST, TG_GRAPHNAME, TG_USERNAME, TG_PASSWORD, TG_RESTPP_PORT, TG_GS_PORT (see docker-compose.yml for values)
```
This still requires the TigerGraph container running separately (`docker compose up -d tigergraph`, or `make mcp-up` which starts both).

| Contract tool (PRD §8.4) | MCP tool name | Installed query | Example |
|---|---|---|---|
| `resolve_trigger` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"resolve_trigger", params:{...}})` |
| `get_entity_profile` | `tigergraph__get_node` + `tigergraph__get_node_edges` | `gsql/` (WS2) | `get_node(player_type="Card", player_id="...")` |
| `get_transaction_history` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"txn_history", params:{...}})` |
| `get_neighborhood` | `tigergraph__get_neighbors` / `tigergraph__run_installed_query` | `gsql/` (WS2) | `get_neighbors(player_type="Card", player_id="...", edge_types=["MADE","USED_DEVICE"])` |
| `compute_velocity` | `tigergraph__run_installed_query` | `sample_card_velocity` (WS1, sample) | `run_installed_query({query_name:"sample_card_velocity", params:{card_id, as_of, window_hours}})` |
| `find_shared_entity_rings` | `tigergraph__run_installed_query` | `sample_link_analysis` (WS1, sample) + `gsql/` (WS2) | `run_installed_query({query_name:"sample_link_analysis", params:{card_id, as_of}})` |
| `get_baseline_deviation` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"baseline_deviation", params:{...}})` |
| `detect_patterns` | `tigergraph__run_installed_query` | `gsql/queries/detect_patterns.gsql` (WS2) | `run_installed_query({query_name:"detect_patterns", params:{...}})` |
| `get_community` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"community_lookup", params:{...}})` |
| `find_prior_cases` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"find_prior_cases", params:{...}})` |
| `vector_search` | `tigergraph__run_installed_query` | `vector_search` (WS2) | `run_installed_query({query_name:"vector_search", params:{vertex_type:"PolicyChunk", query_id, k, pattern_id, as_of, apply_as_of, outcome, qvec, scores_only}})` — cosine top-k over `PolicyChunk`/`FraudCase`; query vector passed as the `qvec` list param (copied into a `ListAccum` at query top level; falls back to the `query_id` vertex's `embedding` when `qvec` is empty); `scores_only:true` returns ids + scores only. Params since 2026-09-23: `…, outcome, qvec, scores_only` — see `gsql/queries/vector_search.gsql` |
| `get_pattern_profile` | `tigergraph__run_installed_query` | `get_pattern_profile` (WS2) | `run_installed_query({query_name:"get_pattern_profile", params:{pattern_id}})` — Pattern fields + `REQUIRES_EVIDENCE`; `permitted_actions` is WS3-local (`rag/src/patterns.ts`), not graph-backed |
| `get_wide_features` | `tigergraph__run_query` (interpreted) | DuckDB (local, not MCP) | per `contracts/tools.ts`; not a graph tool |

General utilities also available through MCP: `tigergraph__get_vertex_count`, `tigergraph__get_edge_count`, `tigergraph__get_graph_schema`, `tigergraph__get_global_schema` (GSQL `LS`), `tigergraph__gsql` (raw GSQL), `tigergraph__list_connections`, `tigergraph__discover_tools`.

WS1's installed sample queries (installed by `make verify-graph` before the MCP smoke): `sample_txn_explain`, `sample_card_velocity`, `sample_link_analysis`, `graph_stats`, `graph_stats_vertices`. The real WS2 toolkit replaces the sample entries above with the production `gsql/` queries.