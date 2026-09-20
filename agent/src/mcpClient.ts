import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { EntityRef, ResolveTriggerData, SharedEntityRing, Trigger } from "@hhgoa/contracts";

/**
 * MCP client wrapper (PRD §9.4): "agent/mcpClient.ts connects to TigerGraph
 * MCP; graph tools in the registry are thin wrappers that call MCP tools."
 *
 * Built against the official `@modelcontextprotocol/sdk` client API (real
 * MCP protocol, stdio or Streamable-HTTP transport) per the coordinator's
 * correction: tigergraph-mcp (https://github.com/tigergraph/tigergraph-mcp)
 * is a required component of the brief, not something to substitute with a
 * plain REST assumption. `RealMcpClient` below routes every one of the 10
 * graph tools through the single `tigergraph__run_installed_query` MCP tool
 * (confirmed live: the server exposes no per-contract-tool-named MCP tools —
 * see docs/MCP_TOOLS.md) at WS2's installed query names, and transforms each
 * query's raw JSON into the exact contract shape. Every test in `tests/ws4/`
 * runs against `FakeMcpClient`; `RealMcpClient` is exercised by
 * `tests/ws4/realMcpClient.live.test.ts` against the live graph.
 *
 * The server wraps every tool result as a single `content[0].text` block:
 * a fenced ```json {"success", "data":{"result":[...]}, "error"?} ``` block
 * followed by a human-readable duplicate — `result` is always a one-element
 * array (every WS2 query issues exactly one PRINT statement). `isError` at
 * the MCP-protocol level stays `false` even on a query failure; the real
 * failure signal is the parsed payload's `success: false` (verified live
 * against both a bad entity id, which the query itself handles by returning
 * empty strings, and a bad query name, which surfaces `success: false` +
 * `error`).
 */

/** EntityRef.type (PascalCase, e.g. "Card") <-> WS2 query entity_type (lowercase, e.g. "card"). */
const ENTITY_TYPE_TO_QUERY_TYPE: Record<string, string> = {
  Transaction: "txn",
  Card: "card",
  Customer: "customer",
  Identity: "identity",
  Device: "device",
  Address: "address",
};

function toQueryEntityType(type: string): string {
  const mapped = ENTITY_TYPE_TO_QUERY_TYPE[type];
  if (!mapped) throw new Error(`RealMcpClient: unknown EntityRef.type "${type}"`);
  return mapped;
}

/** Trigger (PRD §8.3) -> the entity resolve_trigger.gsql needs (its own header comment documents this same mapping). */
function triggerToEntity(trigger: Trigger): { entity_type: string; entity_id: string } {
  switch (trigger.kind) {
    case "risk_score":
      if (trigger.txn_id) return { entity_type: "txn", entity_id: trigger.txn_id };
      if (trigger.card_id) return { entity_type: "card", entity_id: trigger.card_id };
      throw new Error("RealMcpClient: risk_score trigger has neither txn_id nor card_id");
    case "customer_report":
      return { entity_type: "customer", entity_id: trigger.customer_id };
    case "analyst_request":
      return { entity_type: toQueryEntityType(trigger.entity.type), entity_id: trigger.entity.id };
    default: {
      const exhaustive: never = trigger;
      throw new Error(`RealMcpClient: unhandled trigger kind ${JSON.stringify(exhaustive)}`);
    }
  }
}

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
  /**
   * Runs a raw installed GSQL query by name (e.g. the WS7 case-memory writer
   * `upsert_case_record`), bypassing the 10 contract graph tools. Returns the
   * first result row's raw fields. RealMcpClient executes it against the
   * graph; FakeMcpClient throws — writing is a real-backend-only operation.
   */
  runInstalledQuery(queryName: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface McpClientConfig {
  /** Streamable-HTTP transport, e.g. `TIGERGRAPH_MCP_URL` from `.env`. */
  url?: string;
  /** stdio transport fallback: spawn the MCP server as a child process. */
  command?: string;
  args?: string[];
  /** TigerGraph graph name (`TIGERGRAPH_GRAPH_NAME`, default hhgoa_fraud). */
  graphName?: string;
}

// Community-detection guard defaults (must match gsql/install.ts's
// WCC_MAX_HUB_DEGREE / WCC_MIN_OVERLAP_PCT — see docs/decisions.md for the
// measurements behind them). community_lookup.gsql takes these as params
// rather than baking them in so a caller can experiment, but the agent
// always wants the same guards discovery_report.gsql uses.
const COMMUNITY_MAX_HUB_DEGREE = 1000;
const COMMUNITY_MIN_OVERLAP_PCT = 30;

// shared_rings.gsql deliberately applies no hub-degree cap (its own header
// comment: it hands back the raw per-entity card set for the caller to
// judge). Verified live against real data: card C21139-K1's device ring
// comes back as several hundred card_ids through device "74ac7f403a804e8e"
// -- the same missing/default sentinel value gsql/algorithms/
// community_components.gsql excludes for community detection (20 vertices
// with degree > 1000 across the whole dataset; this device is one of them).
// A "ring" this large isn't a fraud ring, it's a placeholder value, so it's
// dropped here rather than returned to the agent as if it were evidence.
// Threshold is generous relative to the actual discovered-pattern sizes
// (9/5/5 cards, see docs/decisions.md) while still excluding sentinel-scale
// noise (hundreds+).
const MAX_PLAUSIBLE_RING_SIZE = 50;

interface RunInstalledQueryEnvelope {
  success: boolean;
  error?: string;
  data?: { result?: unknown[] };
}

/**
 * Real TigerGraph MCP client. Connects lazily on first `callTool` so
 * constructing one (e.g. to read config) never requires a live server.
 * Every method surfaces a clear error when the query fails or the graph is
 * unreachable — it never silently falls back to fake data.
 */
export class RealMcpClient implements McpClient {
  private client: Client | undefined;
  private connecting: Promise<void> | undefined;
  private readonly graphName: string;

  constructor(private readonly config: McpClientConfig) {
    if (!config.url && !config.command) {
      throw new Error(
        "RealMcpClient: no transport configured. Set TIGERGRAPH_MCP_URL (Streamable-HTTP) " +
          "or a stdio command via McpClientConfig.command. See docs/MCP_TOOLS.md.",
      );
    }
    this.graphName = config.graphName ?? "hhgoa_fraud";
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

  /**
   * Calls one installed GSQL query via `tigergraph__run_installed_query` and
   * returns its single PRINT-statement result row (see the class doc for
   * the response-envelope shape this unwraps).
   */
  async runInstalledQuery(queryName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = await this.ensureConnected();
    const result = await client.callTool({
      name: "tigergraph__run_installed_query",
      arguments: { query_name: queryName, params, graph_name: this.graphName },
    });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    const text = content?.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new Error(`RealMcpClient: query "${queryName}" returned no text content`);
    }
    const match = /```json\s*\n([\s\S]*?)\n```/.exec(text);
    if (!match) {
      throw new Error(`RealMcpClient: query "${queryName}" response had no JSON block:\n${text.slice(0, 500)}`);
    }
    const envelope = JSON.parse(match[1] as string) as RunInstalledQueryEnvelope;
    if (!envelope.success) {
      throw new Error(`RealMcpClient: query "${queryName}" failed: ${envelope.error ?? "unknown error"}`);
    }
    const rows = envelope.data?.result;
    if (!rows || rows.length === 0) {
      throw new Error(`RealMcpClient: query "${queryName}" returned no result rows`);
    }
    return rows[0] as Record<string, unknown>;
  }

  /** detect_patterns only accepts a card_id; resolve a non-Card entity to its owning card first. */
  private async resolveToCardId(entity: EntityRef, asOf: string): Promise<string> {
    if (entity.type === "Card") return entity.id;
    const raw = await this.runInstalledQuery("resolve_trigger", {
      entity_type: toQueryEntityType(entity.type),
      entity_id: entity.id,
      as_of: asOf,
    });
    const cardId = raw["card_id"] as string;
    if (!cardId) throw new Error(`RealMcpClient: could not resolve a card for ${entity.type} "${entity.id}"`);
    return cardId;
  }

  async callTool(name: McpGraphToolName, args: Record<string, unknown>): Promise<unknown> {
    const asOf = args["as_of"] as string;
    switch (name) {
      case "resolve_trigger": {
        const { entity_type, entity_id } = triggerToEntity(args["trigger"] as Trigger);
        const raw = await this.runInstalledQuery("resolve_trigger", { entity_type, entity_id, as_of: asOf });
        const data: ResolveTriggerData = {};
        if (raw["txn_id"]) data.txn = { type: "Transaction", id: raw["txn_id"] as string };
        if (raw["card_id"]) data.card = { type: "Card", id: raw["card_id"] as string };
        if (raw["customer_id"]) data.customer = { type: "Customer", id: raw["customer_id"] as string };
        if (raw["identity_id"]) data.identity = { type: "Identity", id: raw["identity_id"] as string };
        return data;
      }

      case "get_entity_profile": {
        const entity = args["entity"] as EntityRef;
        const raw = await this.runInstalledQuery("get_entity_profile", {
          entity_type: toQueryEntityType(entity.type),
          entity_id: entity.id,
          as_of: asOf,
        });
        // identity/device/address branches PRINT a vertex SET (one TigerGraph
        // {v_id, v_type, attributes} object per match); card/customer/txn
        // branches PRINT flat scalar fields directly (see get_entity_profile.gsql).
        if (Array.isArray(raw["entity"])) {
          const vertices = raw["entity"] as Array<{ v_id: string; v_type: string; attributes: Record<string, unknown> }>;
          const v = vertices[0];
          if (!v) throw new Error(`RealMcpClient: get_entity_profile found no ${entity.type} "${entity.id}"`);
          return { entity: { type: v.v_type, id: v.v_id }, attributes: v.attributes };
        }
        const { entity_id: foundId, entity_type: _entityType, ...attributes } = raw;
        return { entity: { type: entity.type, id: (foundId as string) || entity.id }, attributes };
      }

      case "get_transaction_history": {
        const entity = args["entity"] as EntityRef;
        const window = (args["window"] as { hours?: number; days?: number }) ?? {};
        const windowHours = window.hours ?? (window.days ? window.days * 24 : 24);
        const raw = await this.runInstalledQuery("txn_history", {
          entity_type: toQueryEntityType(entity.type),
          entity_id: entity.id,
          as_of: asOf,
          window_hours: windowHours,
        });
        return {
          rows: raw["rows"] ?? [],
          stats: {
            count: (raw["txn_count"] as number) ?? 0,
            total_amount_usd: (raw["total_amount_usd"] as number) ?? 0,
            window: `${(raw["window_hours"] as number) ?? windowHours}h`,
          },
        };
      }

      case "get_neighborhood": {
        const entity = args["entity"] as EntityRef;
        const hops = (args["hops"] as number) ?? 1;
        const raw = await this.runInstalledQuery("neighborhood", { entity_id: entity.id, hops, as_of: asOf });
        const nodes = (raw["nodes"] as Array<{ vtype: string; vid: string }>) ?? [];
        const edges = (raw["edges"] as Array<{ etype: string; efrom: string; eto: string }>) ?? [];
        return {
          nodes: nodes.map((n) => ({ type: n.vtype, id: n.vid })),
          edges: edges.map((e) => ({ type: e.etype, from: e.efrom, to: e.eto })),
        };
      }

      case "compute_velocity": {
        const entity = args["entity"] as EntityRef;
        const windowMinutes = (args["window_minutes"] as number) ?? 60;
        const raw = await this.runInstalledQuery("card_velocity", {
          card_id: entity.id,
          window_minutes: windowMinutes,
          as_of: asOf,
        });
        return {
          count: (raw["txn_count"] as number) ?? 0,
          window_minutes: (raw["window_minutes"] as number) ?? windowMinutes,
          total_amount_usd: (raw["total_amount_usd"] as number) ?? 0,
        };
      }

      case "find_shared_entity_rings": {
        const entity = args["entity"] as EntityRef;
        const raw = await this.runInstalledQuery("shared_rings", { card_id: entity.id, as_of: asOf });
        const rings: SharedEntityRing[] = [];
        const groups: Array<[SharedEntityRing["shared_type"], string]> = [
          ["device", "device_rings"],
          ["address", "address_rings"],
          ["email", "email_rings"],
        ];
        for (const [shared_type, key] of groups) {
          const ring = (raw[key] as Record<string, string[]>) ?? {};
          for (const [shared_id, card_ids] of Object.entries(ring)) {
            if (card_ids.length > MAX_PLAUSIBLE_RING_SIZE) continue;
            rings.push({ shared_type, shared_id, card_ids });
          }
        }
        return { rings };
      }

      case "get_baseline_deviation": {
        const txn = args["txn"] as EntityRef;
        return this.runInstalledQuery("baseline_deviation", { txn_id: txn.id, as_of: asOf });
      }

      case "detect_patterns": {
        const entityOrTxn = args["entity_or_txn"] as EntityRef;
        const cardId = await this.resolveToCardId(entityOrTxn, asOf);
        const raw = await this.runInstalledQuery("detect_patterns", { card_id: cardId, as_of: asOf });
        const scores = (raw["scores"] as Record<string, number>) ?? {};
        const evidence = (raw["evidence"] as Record<string, string[]>) ?? {};
        const patterns = Object.entries(scores).map(([pattern_id, score]) => ({
          pattern_id,
          score,
          evidence: evidence[pattern_id] ?? [],
        }));
        return { patterns };
      }

      case "get_community": {
        const entity = args["entity"] as EntityRef;
        const raw = await this.runInstalledQuery("community_lookup", {
          card_id: entity.id,
          as_of: asOf,
          max_hub_degree: COMMUNITY_MAX_HUB_DEGREE,
          min_overlap_pct: COMMUNITY_MIN_OVERLAP_PCT,
        });
        return {
          community_id: raw["community_id"],
          size: raw["size"],
          stats: {
            avg_risk_score: raw["avg_risk_score"],
            confirmed_fraud_rate: raw["confirmed_fraud_rate"],
            velocity: raw["velocity"],
            shared_device_density: raw["shared_device_density"],
          },
        };
      }

      case "find_prior_cases": {
        const entity = args["entity"] as EntityRef;
        return this.runInstalledQuery("find_prior_cases", { card_id: entity.id, as_of: asOf });
      }

      default: {
        const exhaustive: never = name;
        throw new Error(`RealMcpClient: unhandled tool ${String(exhaustive)}`);
      }
    }
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

  async runInstalledQuery(_queryName: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
    throw new Error(
      "FakeMcpClient.runInstalledQuery: case write-back is a real-backend-only operation; the fake backend " +
        "never writes to TigerGraph (written_to_graph stays false)",
    );
  }

  async close(): Promise<void> {
    // no-op: nothing was ever connected.
  }
}

export function createMcpClient(backend: "fake" | "real", config?: McpClientConfig): McpClient {
  if (backend === "fake") return new FakeMcpClient();
  return new RealMcpClient(
    config ?? {
      url: process.env["TIGERGRAPH_MCP_URL"] ?? "http://127.0.0.1:8000/mcp/",
      graphName: process.env["TIGERGRAPH_GRAPH_NAME"],
    },
  );
}
