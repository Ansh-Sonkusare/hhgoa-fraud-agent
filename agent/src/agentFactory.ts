import type { LlmClient, MockScriptEntry } from "./llm.js";
import { MockLlmClient, OllamaLlmClient } from "./llm.js";
import { createMcpClient, type McpClient } from "./mcpClient.js";
import { FraudInvestigationMachine, type MachineDeps, type RunResult } from "./machine.js";
import type { ToolCatalog, Trigger } from "@hhgoa/contracts";
import { fakes } from "@hhgoa/contracts";
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
 *               TOOLS_BACKEND=real (WS1's tigergraph-mcp server, not up yet)
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

export function createLlmClient(backend: "mock" | "ollama", script?: readonly MockScriptEntry[]): LlmClient {
  if (backend === "ollama") return new OllamaLlmClient();
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
 * Non-MCP `ToolCatalog` providers (RAG/local/policy fakes) for a backend.
 * `fake` uses the frozen contracts fakes. `real` needs WS3's RAG/local
 * services (not yet landed — see docs/REQUESTS.md) so it fails loudly.
 */
export function createToolProviders(backend: "fake" | "real"): ToolCatalog {
  if (backend === "fake") return fakes;
  throw new Error(
    'createToolProviders: TOOLS_BACKEND="real" needs WS1/WS3 services that are not up yet. ' +
      "Stick with fake (contracts fakes) until they land; see docs/REQUESTS.md.",
  );
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
}

/** Build and run a full case end-to-end with default (fake/mock) services. */
export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  const backend = options.backend ?? "fake";
  const machine = new FraudInvestigationMachine({
    caseId: options.caseId,
    asOf: options.asOf,
    trigger: options.trigger,
    llm: options.llm ?? createLlmClient("mock"),
    mcp: options.mcp ?? createMcpClient(backend),
    providers: options.providers ?? createToolProviders(backend),
    policies: options.policies ?? createPolicyAdapters(),
    maxToolCalls: options.maxToolCalls,
    maxEvidenceRounds: options.maxEvidenceRounds,
    maxInvestigateLoops: options.maxInvestigateLoops,
  });
  return machine.run();
}