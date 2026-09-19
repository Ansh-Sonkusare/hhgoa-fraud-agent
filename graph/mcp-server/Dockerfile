# WS1: containerized tigergraph-mcp server (the official TigerGraph MCP server —
# see CLAUDE.md's Stack section for why this is Python, isolated to this directory).
FROM python:3.12-slim

RUN pip install --no-cache-dir tigergraph-mcp==1.0.3

EXPOSE 8000

# Config (TG_HOST, TG_GRAPHNAME, TG_USERNAME, TG_PASSWORD, TG_RESTPP_PORT, TG_GS_PORT)
# comes from the container's environment (see docker-compose.yml), not a mounted .env —
# .env/--env-file stays supported for the native (non-Docker) `pnpm mcp:start` path.
CMD ["tigergraph-mcp", "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "8000"]
