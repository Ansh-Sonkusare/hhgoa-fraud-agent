# MCP tool names

Owned by WS1. The TigerGraph MCP server (https://github.com/tigergraph/tigergraph-mcp, official `tigergraph-mcp`) exposes every graph capability through `tigergraph__*` tools. WS1's agent-facing contract tools (PRD §8.4) map onto them below.

Start the server: `pnpm --filter @hhgoa/graph mcp:start` (streamable HTTP on `127.0.0.1:8000`, config in `graph/mcp-server/.env`). Connect at `http://127.0.0.1:8000/mcp/` (trailing slash required). `graph/scripts/mcpSmoke.ts` runs the 3 WS1 sample queries through it; that is what `make verify-graph` invokes.

| Contract tool (PRD §8.4) | MCP tool name | Installed query | Example |
|---|---|---|---|
| `resolve_trigger` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"resolve_trigger", params:{...}})` |
| `get_entity_profile` | `tigergraph__get_node` + `tigergraph__get_node_edges` | `gsql/` (WS2) | `get_node(player_type="Card", player_id="...")` |
| `get_transaction_history` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"txn_history", params:{...}})` |
| `get_neighborhood` | `tigergraph__get_neighbors` / `tigergraph__run_installed_query` | `gsql/` (WS2) | `get_neighbors(player_type="Card", player_id="...", edge_types=["MADE","USED_DEVICE"])` |
| `compute_velocity` | `tigergraph__run_installed_query` | `sample_card_velocity` (WS1, sample) | `run_installed_query({query_name:"sample_card_velocity", params:{card_id, as_of, window_hours}})` |
| `find_shared_entity_rings` | `tigergraph__run_installed_query` | `sample_link_analysis` (WS1, sample) + `gsql/` (WS2) | `run_installed_query({query_name:"sample_link_analysis", params:{card_id, as_of}})` |
| `get_baseline_deviation` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"baseline_deviation", params:{...}})` |
| `detect_patterns` | `tigergraph__run_installed_query` | `gsql/detectors/` (WS2) | `run_installed_query({query_name:"detect_patterns", params:{...}})` |
| `get_community` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"community_lookup", params:{...}})` |
| `find_prior_cases` | `tigergraph__run_installed_query` | `gsql/` (WS2) | `run_installed_query({query_name:"find_prior_cases", params:{...}})` |
| `get_wide_features` | `tigergraph__run_query` (interpreted) | DuckDB (local, not MCP) | per `contracts/tools.ts`; not a graph tool |

General utilities also available through MCP: `tigergraph__get_vertex_count`, `tigergraph__get_edge_count`, `tigergraph__get_graph_schema`, `tigergraph__get_global_schema` (GSQL `LS`), `tigergraph__gsql` (raw GSQL), `tigergraph__list_connections`, `tigergraph__discover_tools`.

WS1's installed sample queries (installed by `make verify-graph` before the MCP smoke): `sample_txn_explain`, `sample_card_velocity`, `sample_link_analysis`, `graph_stats`, `graph_stats_vertices`. The real WS2 toolkit replaces the sample entries above with the production `gsql/` queries.