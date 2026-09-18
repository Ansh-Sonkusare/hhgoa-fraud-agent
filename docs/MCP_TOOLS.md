# MCP tool names

Owned by WS1. Fill in once TigerGraph MCP (https://github.com/tigergraph/tigergraph-mcp) is connected and installed queries are running through it.

For each tool in PRD.md §8.4's catalog, record the real MCP tool name, its installed-query counterpart in `gsql/`, and one example call/response pair.

| Contract tool (PRD §8.4) | MCP tool name | Installed query | Example |
|---|---|---|---|
| `resolve_trigger` | _pending_ | _pending_ | _pending_ |
| `get_entity_profile` | _pending_ | _pending_ | _pending_ |
| `get_transaction_history` | _pending_ | _pending_ | _pending_ |
| `get_neighborhood` | _pending_ | _pending_ | _pending_ |
| `compute_velocity` | _pending_ | _pending_ | _pending_ |
| `find_shared_entity_rings` | _pending_ | _pending_ | _pending_ |
| `get_baseline_deviation` | _pending_ | _pending_ | _pending_ |
| `detect_patterns` | _pending_ | _pending_ | _pending_ |
| `get_community` | _pending_ | _pending_ | _pending_ |
| `find_prior_cases` | _pending_ | _pending_ | _pending_ |

Until this table is filled in, `agent/mcpClient.ts` must be built and tested against `contracts/fakes.ts`, not this file.
