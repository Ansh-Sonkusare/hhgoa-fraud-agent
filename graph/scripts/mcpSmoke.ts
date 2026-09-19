#!/usr/bin/env tsx
/**
 * graph/scripts/mcpSmoke.ts — WS1: `make verify-graph` MCP stage.
 *
 * Proves "3 sample queries succeed through MCP" (PRD §16 WS1 DoD): connects
 * to the TigerGraph MCP server (official tigergraph-mcp, streamable HTTP, see
 * https://github.com/tigergraph/tigergraph-mcp) and runs the three WS1 sample
 * queries via `tigergraph__run_installed_query`:
 *   sample_txn_explain, sample_card_velocity, sample_link_analysis
 *
 * The queries must be installed on the graph first — `pnpm verify` (scripts/
 * verify.ts) installs them. Makefile `verify-graph` runs verify then this.
 *
 * Usage:
 *   tsx graph/scripts/mcpSmoke.ts                       # defaults from build/txns.csv
 *   tsx graph/scripts/mcpSmoke.ts --txn <id> --card <id> --as-of "YYYY-MM-DD HH:MM:SS"
 *
 * Env:
 *   TIGERGRAPH_MCP_URL   default http://127.0.0.1:8000/mcp/   (trailing slash required)
 *   TIGERGRAPH_GRAPH_NAME default hhgoa_fraud
 *
 * Exits 0 only if all three queries return success through the MCP server.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eachRow } from "./lib/csv.js";

const GRAPH_DIR = path.resolve(import.meta.dirname, "..");
const BUILD_TXNS = path.join(GRAPH_DIR, "build", "txns.csv");
const QUERIES_DIR = path.join(GRAPH_DIR, "queries");
const GRAPH = process.env.TIGERGRAPH_GRAPH_NAME ?? "hhgoa_fraud";
const MCP_URL = process.env.TIGERGRAPH_MCP_URL ?? "http://127.0.0.1:8000/mcp/";

async function pickDefaults(): Promise<{ txnId: string; cardId: string; asOf: string; windowHours: number }> {
  // First non-header row of build/txns.csv: cols 0=id, 1=ts, 13=card_id.
  let row: string[] | null = null;
  let header = true;
  await eachRow(BUILD_TXNS, (r) => {
    if (header) {
      header = false;
      return;
    }
    row = r;
  });
  if (row) {
    return { txnId: row[0], cardId: row[13] ?? "", asOf: row[1] ?? "", windowHours: 24 };
  }
  throw new Error(`mcpSmoke: could not read a sample row from ${BUILD_TXNS}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argVal = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dflt = await pickDefaults();
  const txnId = argVal("--txn") ?? dflt.txnId;
  const cardId = argVal("--card") ?? dflt.cardId;
  const asOf = argVal("--as-of") ?? dflt.asOf;
  const windowHours = 24;

  if (!cardId || !asOf) {
    console.error(`mcpSmoke: cannot derive sample params (txn=${txnId} card=${cardId} as_of=${asOf}); pass --card/--as-of`);
    process.exit(2);
  }

  const url = MCP_URL.endsWith("/") ? MCP_URL : `${MCP_URL}/`;

  const client = new Client(
    { name: "hhgoa-ws1-mcp-smoke", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {});
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    if (!names.includes("tigergraph__run_installed_query")) {
      // eslint-disable-next-line no-console
      console.error(`mcpSmoke: tigergraph__run_installed_query not exposed by the server at ${url}`);
      console.error(`  exposed: ${names.join(", ") || "(none)"}`);
      process.exit(2);
    }
    console.log(`[mcpSmoke] connected to ${url}; ${names.length} tools exposed`);

    const calls: Array<{ name: string; params: Record<string, unknown> }> = [
      { name: "sample_txn_explain", params: { txn_id: txnId, as_of: asOf } },
      { name: "sample_card_velocity", params: { card_id: cardId, as_of: asOf, window_hours: windowHours } },
      { name: "sample_link_analysis", params: { card_id: cardId, as_of: asOf } },
    ];

    for (const call of calls) {
      const file = path.join(QUERIES_DIR, `${call.name}.gsql`);
      if (!existsSync(file)) {
        console.error(`mcpSmoke: query source missing (${file}); cannot install/run ${call.name}`);
        process.exit(2);
      }
      const res = await client.callTool({
        name: "tigergraph__run_installed_query",
        arguments: { query_name: call.name, params: call.params, graph_name: GRAPH },
      });
      const content = (res.content as Array<{ type?: string; text?: string }>) ?? [];
      const text = content
        .filter((c) => typeof c === "object" && c !== null && typeof (c as { text?: string }).text === "string")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      const structured = (res as { structuredContent?: unknown }).structuredContent;

      const okPayload = structured
        ? structured
        : /"success"\s*:\s*true/.test(text)
          ? text
          : null;

      if (!okPayload) {
        console.error(`mcpSmoke: ${call.name} FAILED through MCP:\n${text.slice(0, 1500)}`);
        throw new Error(`query ${call.name} failed`);
      }
      const summary = typeof okPayload === "string" ? okPayload.slice(0, 900) : JSON.stringify(okPayload);
      console.log(`[mcpSmoke] ok  ${call.name}(${JSON.stringify(call.params).slice(0, 120)})`);
      console.log(`            ${summary.replace(/\s+/g, " ").slice(0, 300)}`);
    }

    console.log("[mcpSmoke] PASS — sample_txn_explain, sample_card_velocity, sample_link_analysis via MCP");
  } finally {
    await client.close();
  }
}

await main().catch((err) => {
  console.error(`[mcpSmoke] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  console.error("[mcpSmoke] Hint: make sure the TigerGraph container AND the MCP server are running (pnpm mcp:start)");
  process.exit(1);
});