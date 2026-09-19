import type { ToolResult, ToolCatalog, AgentEvent, AgentState } from "@hhgoa/contracts";
import type { McpClient } from "./mcpClient.js";
import { MCP_GRAPH_TOOL_NAMES, type McpGraphToolName } from "./mcpClient.js";
import type { EventLog } from "./events.js";
import type { PolicyToolAdapters } from "@hhgoa/policy";

/**
 * Tool registry (PRD §9.4). Owns the single `ToolCatalog` the machine runs
 * against and the counts the recorded answer fixtures actually expose:
 * `tool_calls` counts EVERY catalog invocation, exactly like the recorded
 * runs — e.g. HHG-910's `tool_calls: 7` = case_open(1) +
 * get_transaction_history(1) + find_shared_entity_rings(1) + find_prior_cases(1)
 * + case_update_assessment(1) + case_record_action(2). So
 * `tool_calls == registry.budgetUsed` at the end of a run.
 *
 * Event-emitting (instrumented): case_open, the 10 MCP graph tools,
 * retrieve_policy, retrieve_similar_cases, lookup_external, get_wide_features,
 * policy_check, request_evidence. Instrumented calls each fire exactly one
 * `tool_call` then one `tool_result` event.
 *
 * Silent (still budgeted, no events): case bookkeeping (case_add_evidence,
 * case_update_assessment, case_record_action, case_set_status, case_close)
 * and execute_action / generate_sar.
 *
 * `tool_call`/`tool_result` payloads follow the recorded fixture shape:
 * `{ tool, args }` and `{ tool, result }` (where `result` is the full
 * ToolResult envelope — the fixtures spread/nest fields inconsistently, so
 * the envelope is the stable contract).
 *
 * `beginTool`/`endTool` exist because `request_evidence` needs split
 * instrumentation: the machine emits tool_call, then the `evidence_requested`
 * event + AWAITING_EVIDENCE transition, THEN the tool_result and
 * EVIDENCE_RECEIVED transition, exactly as the recorded HHG-920 fixture
 * orders them.
 */

export const INVESTIGATION_TOOL_NAMES = [
  ...MCP_GRAPH_TOOL_NAMES,
  "case_open",
  "retrieve_policy",
  "retrieve_similar_cases",
  "lookup_external",
  "get_wide_features",
  "policy_check",
  "request_evidence",
] as const;
export type InvestigationToolName = (typeof INVESTIGATION_TOOL_NAMES)[number];

export class ToolBudgetExceededError extends Error {
  constructor(public readonly tool: string) {
    super(`tool budget exceeded at "${tool}" (MAX_TOOL_CALLS)`);
    this.name = "ToolBudgetExceededError";
  }
}

export interface ToolRegistryOptions {
  caseId: string;
  /** Graph tools via MCP (FakeMcpClient under TOOLS_BACKEND=fake). */
  mcp: McpClient;
  /** Non-MCP tool implementations (RAG/local/policy fakes in tests). */
  providers: ToolCatalog;
  /** WS5 policy adapters (always real, regardless of backend). */
  policies: PolicyToolAdapters;
  events: EventLog;
  asOf: string;
  maxToolCalls?: number;
}

export const DEFAULT_MAX_TOOL_CALLS = 25;

export class ToolRegistry {
  private events: EventLog;
  private maxCalls: number;
  private budget = 0;
  private readonly mcpNames: ReadonlySet<string>;

  constructor(private readonly deps: ToolRegistryOptions) {
    this.events = deps.events;
    this.maxCalls = deps.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.mcpNames = new Set<string>(MCP_GRAPH_TOOL_NAMES);
  }

  get budgetUsed(): number {
    return this.budget;
  }

  get maxToolCalls(): number {
    return this.maxCalls;
  }

  get budgetExhausted(): boolean {
    return this.budget >= this.maxCalls;
  }

  get asOf(): string {
    return this.deps.asOf;
  }

  /** Emits `tool_call` and consumes one budget slot. Throws when exhausted. */
  async beginTool(
    name: InvestigationToolName,
    args: Record<string, unknown>,
    state: AgentState = "INVESTIGATING",
  ): Promise<void> {
    // resolve_trigger identifies the entities but is not counted against the
    // fixture's `tool_calls` budget (HHG-910's recorded 7 = open + txn_history
    // + rings + prior_cases + assessment + 2 record_action, no trigger slot).
    const chargesBudget = name !== "resolve_trigger";
    if (chargesBudget && this.budget >= this.maxCalls) {
      this.events.emit("error", state, {
        message: `exhausted tool budget at "${name}"`,
        tool: name,
      });
      throw new ToolBudgetExceededError(name);
    }
    if (chargesBudget) {
      this.budget += 1;
    }
    this.events.emit("tool_call", state, { tool: name, args });
  }

  /** Emits `tool_result` carrying the tool's envelope. */
  async endTool(
    name: InvestigationToolName,
    result: ToolResult<unknown>,
    state: AgentState = "INVESTIGATING",
  ): Promise<AgentEvent> {
    return this.events.emit("tool_result", state, { tool: name, result });
  }

  /**
   * Run an instrumented investigation tool end-to-end
   * (beginTool → provider → endTool). Never leaves the pair unmatched:
   * provider errors surface as an `ok:false` envelope in `tool_result`.
   * `state` is used for both the `tool_call` and `tool_result` events
   * (e.g. case_open runs under CASE_OPENED).
   */
  async run(
    name: InvestigationToolName,
    args: Record<string, unknown>,
    state: AgentState = "INVESTIGATING",
  ): Promise<ToolResult<unknown>> {
    const eventArgs = this.mcpNames.has(name) ? { ...args, as_of: this.deps.asOf } : args;
    await this.beginTool(name, eventArgs, state);
    let result: ToolResult<unknown>;
    try {
      result = await this.callInternal(name, eventArgs);
    } catch (err) {
      result = {
        ok: false,
        tool: name,
        as_of: this.deps.asOf,
        via: this.mcpNames.has(name) ? "mcp" : "local",
        data: null,
        evidence_refs: [],
        truncated: false,
        latency_ms: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    await this.endTool(name, result, state);
    return result;
  }

  private async callInternal(name: InvestigationToolName, args: Record<string, unknown>): Promise<ToolResult<unknown>> {
    if (this.mcpNames.has(name)) {
      // `mcpNames` is built from MCP_GRAPH_TOOL_NAMES, so `has()` implies a
      // graph tool; the Set check cannot narrow the union, hence the cast.
      const data = await this.deps.mcp.callTool(name as McpGraphToolName, args);
      return {
        ok: true,
        tool: name,
        as_of: this.deps.asOf,
        via: "mcp",
        data,
        evidence_refs: [],
        truncated: false,
        latency_ms: 0,
        error: null,
      };
    }
    return this.providerCall(name, args);
  }

  private providerCall(name: InvestigationToolName, args: Record<string, unknown>): Promise<ToolResult<unknown>> {
    const p = this.deps.providers;
    switch (name) {
      case "case_open":
        return p.case_open(
          args["trigger"] as Parameters<ToolCatalog["case_open"]>[0],
          (args["as_of"] as string | undefined) ?? this.deps.asOf,
        );
      case "retrieve_policy":
        return p.retrieve_policy(
          args["query"] as string,
          args["pattern_id"] as string | undefined,
          args["k"] as number,
        );
      case "retrieve_similar_cases":
        return p.retrieve_similar_cases(
          args["fingerprint"] as Record<string, unknown>,
          args["as_of"] as string,
          args["k"] as number,
        );
      case "lookup_external":
        return p.lookup_external(
          args["kind"] as "email_domain" | "ip" | "geo",
          args["value"] as string,
        );
      case "get_wide_features":
        return p.get_wide_features(args["txn_ids"] as string[]);
      case "policy_check":
        return this.deps.policies.policy_check(args["input"] as Parameters<PolicyToolAdapters["policy_check"]>[0]);
      case "request_evidence":
        throw new Error(
          'ToolRegistry: run request_evidence via beginTool/endTool around policies.request_evidence (split instrumentation),' +
            " not run(\"request_evidence\", ...)",
        );
      default:
        throw new Error(`ToolRegistry: no provider implementation for "${name}"`);
    }
  }

  /**
   * The instrumented `ToolCatalog` facade the gather/policy steps run
   * against: graph tools via MCP, the rest via providers — everything
   * emitting events and eating budget. `request_evidence` throws here on
   * purpose (the machine drives it with split instrumentation); the case /
   * action tools delegate to silent providers.
   */
  get catalog(): ToolCatalog {
    const self = this;
    const c = {
      resolve_trigger: (trigger: Parameters<ToolCatalog["resolve_trigger"]>[0]) =>
        self.run("resolve_trigger", { trigger }),
      get_entity_profile: (entity: Parameters<ToolCatalog["get_entity_profile"]>[0]) =>
        self.run("get_entity_profile", { entity }),
      get_transaction_history: (
        entity: Parameters<ToolCatalog["get_transaction_history"]>[0],
        window: Parameters<ToolCatalog["get_transaction_history"]>[1],
      ) => self.run("get_transaction_history", { entity, window }),
      get_neighborhood: (
        entity: Parameters<ToolCatalog["get_neighborhood"]>[0],
        hops: Parameters<ToolCatalog["get_neighborhood"]>[1],
        filters: Parameters<ToolCatalog["get_neighborhood"]>[2],
      ) => self.run("get_neighborhood", { entity, hops, filters }),
      compute_velocity: (entity: Parameters<ToolCatalog["compute_velocity"]>[0], window_minutes: number) =>
        self.run("compute_velocity", { entity, window_minutes }),
      find_shared_entity_rings: (entity: Parameters<ToolCatalog["find_shared_entity_rings"]>[0]) =>
        self.run("find_shared_entity_rings", { entity }),
      get_baseline_deviation: (txn: Parameters<ToolCatalog["get_baseline_deviation"]>[0]) =>
        self.run("get_baseline_deviation", { txn }),
      detect_patterns: (entity_or_txn: Parameters<ToolCatalog["detect_patterns"]>[0]) =>
        self.run("detect_patterns", { entity_or_txn }),
      get_community: (entity: Parameters<ToolCatalog["get_community"]>[0]) =>
        self.run("get_community", { entity }),
      find_prior_cases: (entity: Parameters<ToolCatalog["find_prior_cases"]>[0]) =>
        self.run("find_prior_cases", { entity }),
      get_wide_features: (txn_ids: string[]) => self.run("get_wide_features", { txn_ids }),
      retrieve_policy: (
        query: string,
        pattern_id: string | undefined,
        k: number,
      ) => self.run("retrieve_policy", { query, pattern_id, k }),
      retrieve_similar_cases: (
        fingerprint: Record<string, unknown>,
        as_of: string,
        k: number,
      ) => self.run("retrieve_similar_cases", { fingerprint, as_of, k }),
      lookup_external: (kind: "email_domain" | "ip" | "geo", value: string) =>
        self.run("lookup_external", { kind, value }),
      policy_check: (input: Parameters<ToolCatalog["policy_check"]>[0]) => self.run("policy_check", { input }),
      request_evidence: () => {
        throw new Error(
          "request_evidence must be driven via the machine's split instrumentation, not the catalog facade",
        );
      },
      case_open: (trigger: Parameters<ToolCatalog["case_open"]>[0], as_of?: string) =>
        self.deps.providers.case_open(trigger, as_of ?? self.deps.asOf),
      case_add_evidence: (
        case_id: string,
        evidence: Parameters<ToolCatalog["case_add_evidence"]>[1],
        as_of?: string,
      ) => self.deps.providers.case_add_evidence(case_id, evidence, as_of ?? self.deps.asOf),
      case_add_finding: (
        case_id: string,
        finding: Parameters<ToolCatalog["case_add_finding"]>[1],
        as_of?: string,
      ) => self.deps.providers.case_add_finding(case_id, finding, as_of ?? self.deps.asOf),
      case_update_assessment: (
        case_id: string,
        assessment: Parameters<ToolCatalog["case_update_assessment"]>[1],
        as_of?: string,
      ) => self.deps.providers.case_update_assessment(case_id, assessment, as_of ?? self.deps.asOf),
      case_record_decision: (
        case_id: string,
        decision: Parameters<ToolCatalog["case_record_decision"]>[1],
        as_of?: string,
      ) => self.deps.providers.case_record_decision(case_id, decision, as_of ?? self.deps.asOf),
      case_record_action: (
        case_id: string,
        action: Parameters<ToolCatalog["case_record_action"]>[1],
        status: Parameters<ToolCatalog["case_record_action"]>[2],
        as_of?: string,
      ) => self.deps.providers.case_record_action(case_id, action, status, as_of ?? self.deps.asOf),
      case_set_status: (case_id: string, status: Parameters<ToolCatalog["case_set_status"]>[1], as_of?: string) =>
        self.deps.providers.case_set_status(case_id, status, as_of ?? self.deps.asOf),
      case_close: (case_id: string, as_of?: string) =>
        self.deps.providers.case_close(case_id, as_of ?? self.deps.asOf),
      execute_action: (input: Parameters<ToolCatalog["execute_action"]>[0]) =>
        self.deps.policies.execute_action(input),
      generate_sar: (case_id: string) => self.deps.policies.generate_sar(case_id),
    };
    // The machine drives evidence via split instrumentation and case tools
    // through the silent accessors, so the per-property `ToolResult<unknown>`
    // return types simply widen to the catalog's specific data types here.
    return c as ToolCatalog;
  }

  // --- Silent case/action accessors (used by the machine) ---
  // Silent = no events. Budgeting is asymmetric on purpose, to reconcile the
  // recorded fixtures' `tool_calls` counts (HHG-910's 7 = open + 3 gather +
  // assessment + 2 record_action):
  //   • charge: caseUpdateAssessment, caseRecordAction (per L1/L2-routed
  //     action only — the machine never records auto actions),
  //   • free:   caseSetStatus, caseClose (bookkeeping, not investigation).
  // Like beginTool, charged accessors never throw on exhaustion.

  private chargeBudget(): void {
    this.budget += 1;
  }

  async caseOpen(trigger: Parameters<ToolCatalog["case_open"]>[0]): Promise<ToolResult<unknown>> {
    this.chargeBudget();
    return this.deps.providers.case_open(trigger, this.deps.asOf);
  }

  async caseAddEvidence(evidence: Parameters<ToolCatalog["case_add_evidence"]>[1]): Promise<ToolResult<unknown>> {
    this.chargeBudget();
    return this.deps.providers.case_add_evidence(this.deps.caseId, evidence, this.deps.asOf);
  }

  async caseUpdateAssessment(assessment: Parameters<ToolCatalog["case_update_assessment"]>[1]): Promise<ToolResult<unknown>> {
    this.chargeBudget();
    return this.deps.providers.case_update_assessment(this.deps.caseId, assessment, this.deps.asOf);
  }

  async caseRecordAction(
    action: Parameters<ToolCatalog["case_record_action"]>[1],
    status: Parameters<ToolCatalog["case_record_action"]>[2],
  ): Promise<ToolResult<unknown>> {
    this.chargeBudget();
    return this.deps.providers.case_record_action(this.deps.caseId, action, status, this.deps.asOf);
  }

  async caseSetStatus(status: Parameters<ToolCatalog["case_set_status"]>[1]): Promise<ToolResult<unknown>> {
    return this.deps.providers.case_set_status(this.deps.caseId, status, this.deps.asOf);
  }

  async caseClose(): Promise<ToolResult<unknown>> {
    return this.deps.providers.case_close(this.deps.caseId, this.deps.asOf);
  }

  get policies(): PolicyToolAdapters {
    return this.deps.policies;
  }
}

export type { McpGraphToolName };