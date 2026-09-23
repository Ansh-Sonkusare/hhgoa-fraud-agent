import type { LlmClient, MockScriptEntry } from "./llm.js";
import { MockLlmClient, OllamaLlmClient, OpenAiCompatLlmClient } from "./llm.js";
import { createMcpClient, type McpClient } from "./mcpClient.js";
import { FraudInvestigationMachine, type MachineDeps, type RunResult } from "./machine.js";
import { persistCaseToGraph } from "./persistCase.js";
import { InMemoryCaseLedger } from "./caseLedger.js";
import { patternScorerFromEnv, type PatternScorer } from "./patternScorer.js";
import type { EvidenceItem, ToolCatalog, Trigger } from "@hhgoa/contracts";
import { fakes } from "@hhgoa/contracts";
import { createRagRuntime, type RagRuntime } from "@hhgoa/rag";
import {
  createPolicyToolAdapters,
  InMemoryActionsMock,
  SimulatedResponder,
  UIApprovalChannel,
  type PolicyToolAdapters,
} from "@hhgoa/policy";

/**
 * Dependency factory for the WS4 agent (PRD §9.4 "agentFactory).
 *
 * The default assembly is what every benchmark run uses:
 *   • LLM:      MockLlmClient (deterministic) unless LLM_BACKEND=ollama
 *   • Graph:    FakeMcpClient over the contracts fakes unless
 *               TOOLS_BACKEND=real (WS1's tigergraph-mcp server + WS2's
 *               gsql/ installed queries via MCP -- see mcpClient.ts)
 *   • RAG:      contracts fakes unless TOOLS_BACKEND=real (WS3's real
 *               retrieve_policy/retrieve_similar_cases/lookup_external via
 *               @hhgoa/rag's local vector stores)
 *   • Cases:    contracts fakes (canned, stateless) unless TOOLS_BACKEND=real
 *               (an in-memory, per-run case ledger — see caseLedger.ts for
 *               why this stays in-memory rather than a graph write)
 *   • Policy:   always-real WS5 adapters (UIApprovalChannel +
 *               InMemoryActionsMock + SimulatedResponder)
 *
 * A fully-defaulted run yields a deterministic, sufficient first-pass
 * "clear fraud" answer on the contracts/examples data.
 */

export const DEFAULT_MOCK_SCRIPT: readonly MockScriptEntry[] = [
  {
    json: {
      hypotheses: [
        { fraud_type: "card_testing", probability: 0.82, supporting: [], contradicting: [] },
        { fraud_type: "legitimate", probability: 0.1, supporting: [], contradicting: [] },
      ],
      risk_level: "HIGH",
      risk_score: 0.6,
      confidence: 0.8,
      legit_hypothesis_probability: 0.1,
    },
  },
];

export function createLlmClient(backend: "mock" | "ollama" | "openai", script?: readonly MockScriptEntry[]): LlmClient {
  if (backend === "ollama") return new OllamaLlmClient();
  if (backend === "openai") return new OpenAiCompatLlmClient();
  return new MockLlmClient(script ?? DEFAULT_MOCK_SCRIPT);
}

export function createPolicyAdapters(): PolicyToolAdapters {
  return createPolicyToolAdapters({
    approvalChannel: new UIApprovalChannel(),
    actionsMock: new InMemoryActionsMock(),
    responder: new SimulatedResponder(),
  });
}

/**
 * A provider method that should never actually be invoked through
 * `ToolCatalog.providers` (its tool is routed elsewhere — the 10 graph
 * tools via MCP through `ToolRegistry`, policy_check/execute_action/
 * generate_sar via `policies`). Required only so the returned object
 * satisfies the full `ToolCatalog` type; throwing loudly here catches a
 * real wiring bug instead of silently returning fake data under
 * TOOLS_BACKEND=real.
 */
function unreachableProvider(tool: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`createToolProviders(real): "${tool}" is not routed through providers — this is a wiring bug`);
  };
}

/**
 * Non-MCP `ToolCatalog` providers (RAG/local-DuckDB/case-bookkeeping) for a
 * backend. `fake` uses the frozen contracts fakes. `real` combines WS3's
 * real RAG runtime (`@hhgoa/rag`) with an in-memory case ledger; the 10
 * graph-tool members and policy_check/execute_action/generate_sar are never
 * actually called through this object (see `unreachableProvider`), and
 * `get_wide_features` (local DuckDB) has no real implementation yet, so it
 * fails loudly rather than pretend — see docs/REQUESTS.md if a workstream
 * picks that up.
 */
export async function createToolProviders(
  backend: "fake" | "real",
  caseId: string,
  rag?: RagRuntime,
): Promise<ToolCatalog> {
  if (backend === "fake") return fakes;

  const runtime = rag ?? createRagRuntime();
  if (!rag) await runtime.ensureIngested();
  const ledger = new InMemoryCaseLedger(caseId);

  return {
    resolve_trigger: unreachableProvider("resolve_trigger"),
    get_entity_profile: unreachableProvider("get_entity_profile"),
    get_transaction_history: unreachableProvider("get_transaction_history"),
    get_neighborhood: unreachableProvider("get_neighborhood"),
    compute_velocity: unreachableProvider("compute_velocity"),
    find_shared_entity_rings: unreachableProvider("find_shared_entity_rings"),
    get_baseline_deviation: unreachableProvider("get_baseline_deviation"),
    detect_patterns: unreachableProvider("detect_patterns"),
    get_community: unreachableProvider("get_community"),
    find_prior_cases: unreachableProvider("find_prior_cases"),
    get_wide_features: () => {
      throw new Error(
        'createToolProviders(real): "get_wide_features" (local DuckDB) has no real implementation yet. ' +
          "See docs/REQUESTS.md.",
      );
    },
    retrieve_policy: runtime.retrieve_policy,
    retrieve_similar_cases: runtime.retrieve_similar_cases,
    lookup_external: runtime.lookup_external,
    request_evidence: unreachableProvider("request_evidence"),
    case_open: ledger.case_open,
    case_add_evidence: ledger.case_add_evidence,
    case_add_finding: ledger.case_add_finding,
    case_update_assessment: ledger.case_update_assessment,
    case_record_decision: ledger.case_record_decision,
    case_record_action: ledger.case_record_action,
    case_set_status: ledger.case_set_status,
    case_close: ledger.case_close,
    policy_check: unreachableProvider("policy_check"),
    execute_action: unreachableProvider("execute_action"),
    generate_sar: unreachableProvider("generate_sar"),
  };
}

export type { MachineDeps, RunResult };

export interface RunAgentOptions {
  caseId: string;
  asOf: string;
  trigger: Trigger;
  backend?: "fake" | "real";
  mcp?: McpClient;
  llm?: LlmClient;
  providers?: ToolCatalog;
  policies?: PolicyToolAdapters;
  maxToolCalls?: number;
  maxEvidenceRounds?: number;
  maxInvestigateLoops?: number;
  /**
   * Write the closed case back into graph + RAG memory. On by default for a
   * real backend. A measurement harness must pass false: the backtest scores
   * the agent against closed cases that live in the same store, so persisting
   * synthetic records mid-run contaminates the very memory being measured —
   * later cases in the sample read earlier ones back as genuine prior cases.
   */
  writeBackCase?: boolean;
  /** Pattern scorer; defaults to patternScorerFromEnv() on a real backend, none otherwise. */
  scorer?: PatternScorer | null;
  /** Evidence calibration of model-alert probabilities (alertCalibration.ts); on by default. */
  calibrateAlerts?: boolean;
}

/** Build and run a full case end-to-end with default (fake/mock) services. */
export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  return (await buildMachine(options)).run();
}

/**
 * The evidence the agent would gather on this case at `asOf`, with no LLM call,
 * no case opened and nothing written back. Used by the Kev training export.
 */
export async function collectCaseEvidence(options: RunAgentOptions): Promise<EvidenceItem[]> {
  return (await buildMachine({ ...options, writeBackCase: false })).collectEvidence();
}

export interface EvidenceCollector {
  collect(target: { caseId: string; asOf: string; trigger: Trigger }): Promise<EvidenceItem[]>;
  close(): Promise<void>;
}

/**
 * A reusable real-backend evidence collector: one RAG runtime and one MCP
 * connection shared across many cases, where runAgent builds both per case.
 */
export async function createEvidenceCollector(): Promise<EvidenceCollector> {
  const rag = createRagRuntime();
  await rag.ensureIngested();
  const mcp = createMcpClient("real");
  return {
    collect: async (target) =>
      collectCaseEvidence({
        ...target,
        backend: "real",
        mcp,
        providers: await createToolProviders("real", target.caseId, rag),
      }),
    close: () => mcp.close(),
  };
}

/**
 * The one construction path for a configured agent: the benchmark runner
 * (runAgent) and the API's live runs both come through here, so a live demo
 * run uses the same pattern scorer, alert calibration and graph write-back
 * as the answers in cases/.
 */
export async function createAgentMachine(options: RunAgentOptions): Promise<FraudInvestigationMachine> {
  return buildMachine(options);
}

async function buildMachine(options: RunAgentOptions): Promise<FraudInvestigationMachine> {
  const backend = options.backend ?? "fake";
  const mcp = options.mcp ?? createMcpClient(backend);
  let providers = options.providers;
  let persistCase: MachineDeps["persistCase"] | undefined;
  if (!providers) {
    if (backend === "real") {
      // One real RAG runtime shared by the tool providers and the case
      // write-back (same local vector stores, single ingest pass).
      const rag = createRagRuntime();
      await rag.ensureIngested();
      providers = await createToolProviders("real", options.caseId, rag);
      if (options.writeBackCase !== false) {
        persistCase = (request) => persistCaseToGraph(mcp, rag, request);
      }
    } else {
      providers = await createToolProviders("fake", options.caseId);
    }
  }

  const machine = new FraudInvestigationMachine({
    caseId: options.caseId,
    asOf: options.asOf,
    trigger: options.trigger,
    llm: options.llm ?? createLlmClient("mock"),
    mcp,
    providers,
    policies: options.policies ?? createPolicyAdapters(),
    persistCase,
    maxToolCalls: options.maxToolCalls,
    maxEvidenceRounds: options.maxEvidenceRounds,
    maxInvestigateLoops: options.maxInvestigateLoops,
    scorer: options.scorer !== undefined ? options.scorer : backend === "real" ? patternScorerFromEnv() : null,
    calibrateAlerts: options.calibrateAlerts ?? true,
  });
  return machine;
}