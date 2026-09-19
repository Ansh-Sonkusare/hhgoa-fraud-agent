import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * MCP client wrapper (PRD §9.4): "agent/mcpClient.ts connects to TigerGraph
 * MCP; graph tools in the registry are thin wrappers that call MCP tools."
 *
 * Built against the official `@modelcontextprotocol/sdk` client API (real
 * MCP protocol, stdio or Streamable-HTTP transport) per the coordinator's
 * correction: tigergraph-mcp (https://github.com/tigergraph/tigergraph-mcp)
 * is a required component of the brief, not something to substitute with a
 * plain REST assumption. No live TigerGraph MCP server exists in this
 * worktree yet (WS1 is standing one up as an external Docker service in a
 * parallel worktree) — `RealMcpClient` below is written against the real
 * client API so that once WS1's server lands and `TOOLS_BACKEND=real`,
 * `createMcpClient("real", ...)` needs only the right env vars, not a
 * rewrite. Every test in `tests/ws4/` runs against `FakeMcpClient`.
 */

/** The 10 graph tools that go through MCP -> installed GSQL queries (contracts/src/tools.ts). */
export const MCP_GRAPH_TOOL_NAMES = [
  "resolve_trigger",
  "get_entity_profile",
  "get_transaction_history",
  "get_neighborhood",
  "compute_velocity",
  "find_shared_entity_rings",
  "get_baseline_deviation",
  "detect_patterns",
  "get_community",
  "find_prior_cases",
] as const;
export type McpGraphToolName = (typeof MCP_GRAPH_TOOL_NAMES)[number];

export interface McpClient {
  /** Calls an installed GSQL query by MCP tool name; returns the tool's raw `data` payload. */
  callTool(name: McpGraphToolName, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientConfig {
  /** Streamable-HTTP transport, e.g. `TIGERGRAPH_MCP_URL` from `.env`. */
  url?: string;
  /** stdio transport fallback: spawn the MCP server as a child process. */
  command?: string;
  args?: string[];
}

/**
 * Real TigerGraph MCP client. Connects lazily on first `callTool` so
 * constructing one (e.g. to read config) never requires a live server.
 * Every method surfaces a clear error until WS1's server is reachable —
 * it never silently falls back to fake data.
 */
export class RealMcpClient implements McpClient {
  private client: Client | undefined;
  private connecting: Promise<void> | undefined;

  constructor(private readonly config: McpClientConfig) {
    if (!config.url && !config.command) {
      throw new Error(
        "RealMcpClient: no transport configured. Set TIGERGRAPH_MCP_URL (Streamable-HTTP) " +
          "or a stdio command via McpClientConfig.command. See docs/REQUESTS.md — WS1 owns " +
          "standing up the tigergraph-mcp server and publishing this in docs/MCP_TOOLS.md.",
      );
    }
  }

  private buildTransport(): Transport {
    if (this.config.url) {
      return new StreamableHTTPClientTransport(new URL(this.config.url));
    }
    // config.command is guaranteed set by the constructor guard above when url isn't.
    return new StdioClientTransport({
      command: this.config.command as string,
      args: this.config.args ?? [],
    });
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const client = new Client({ name: "hhgoa-fraud-agent", version: "0.1.0" });
      await client.connect(this.buildTransport());
      this.client = client;
    })();
    await this.connecting;
    if (!this.client) {
      throw new Error("RealMcpClient: connection did not initialize the client");
    }
    return this.client;
  }

  async callTool(name: McpGraphToolName, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name, arguments: args });
    // Prefer structured content (MCP tools may declare an output schema);
    // fall back to parsing the first text content block as JSON, which is
    // how most MCP servers (including tigergraph-mcp) surface query results.
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) return structured;
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    const firstText = content?.find((block) => block.type === "text")?.text;
    if (firstText !== undefined) {
      return JSON.parse(firstText) as unknown;
    }
    throw new Error(`RealMcpClient: tool "${name}" returned no structuredContent and no text content`);
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}

/**
 * Fake MCP client (PRD §8.6): every graph tool call is routed through this
 * same `McpClient` interface so `toolsRegistry.ts` doesn't special-case
 * `TOOLS_BACKEND=fake` — it just builds a different `McpClient`. Backed by
 * `contracts/src/fakes.ts`, which already tags graph-tool results
 * `via: "mcp"`.
 */
export class FakeMcpClient implements McpClient {
  async callTool(name: McpGraphToolName, args: Record<string, unknown>): Promise<unknown> {
    const { fakes } = await import("@hhgoa/contracts");
    const as_of = typeof args["as_of"] === "string" ? args["as_of"] : "n/a";
    switch (name) {
      case "resolve_trigger": {
        const result = await fakes.resolve_trigger(
          args["trigger"] as Parameters<typeof fakes.resolve_trigger>[0],
          as_of,
        );
        return result.data;
      }
      case "get_entity_profile": {
        const result = await fakes.get_entity_profile(
          args["entity"] as Parameters<typeof fakes.get_entity_profile>[0],
          as_of,
        );
        return result.data;
      }
      case "get_transaction_history": {
        const result = await fakes.get_transaction_history(
          args["entity"] as Parameters<typeof fakes.get_transaction_history>[0],
          (args["window"] as Parameters<typeof fakes.get_transaction_history>[1]) ?? {},
          as_of,
        );
        return result.data;
      }
      case "get_neighborhood": {
        const result = await fakes.get_neighborhood(
          args["entity"] as Parameters<typeof fakes.get_neighborhood>[0],
          (args["hops"] as Parameters<typeof fakes.get_neighborhood>[1]) ?? 1,
          (args["filters"] as Parameters<typeof fakes.get_neighborhood>[2]) ?? {},
          as_of,
        );
        return result.data;
      }
      case "compute_velocity": {
        const result = await fakes.compute_velocity(
          args["entity"] as Parameters<typeof fakes.compute_velocity>[0],
          (args["window_minutes"] as number) ?? 60,
          as_of,
        );
        return result.data;
      }
      case "find_shared_entity_rings": {
        const result = await fakes.find_shared_entity_rings(
          args["entity"] as Parameters<typeof fakes.find_shared_entity_rings>[0],
          as_of,
        );
        return result.data;
      }
      case "get_baseline_deviation": {
        const result = await fakes.get_baseline_deviation(
          args["txn"] as Parameters<typeof fakes.get_baseline_deviation>[0],
          as_of,
        );
        return result.data;
      }
      case "detect_patterns": {
        const result = await fakes.detect_patterns(
          args["entity_or_txn"] as Parameters<typeof fakes.detect_patterns>[0],
          as_of,
        );
        return result.data;
      }
      case "get_community": {
        const result = await fakes.get_community(
          args["entity"] as Parameters<typeof fakes.get_community>[0],
          as_of,
        );
        return result.data;
      }
      case "find_prior_cases": {
        const result = await fakes.find_prior_cases(
          args["entity"] as Parameters<typeof fakes.find_prior_cases>[0],
          as_of,
        );
        return result.data;
      }
      default: {
        const exhaustive: never = name;
        throw new Error(`FakeMcpClient: unhandled tool ${String(exhaustive)}`);
      }
    }
  }

  async close(): Promise<void> {
    // no-op: nothing was ever connected.
  }
}

export function createMcpClient(backend: "fake" | "real", config?: McpClientConfig): McpClient {
  if (backend === "fake") return new FakeMcpClient();
  return new RealMcpClient(config ?? { url: process.env["TIGERGRAPH_MCP_URL"] });
}
