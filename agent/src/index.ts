// WS4 agent public API (PRD §9.2–§9.4). The machine orchestrates the
// states; the dependency factory wires the real/fake services.
export { FraudInvestigationMachine } from "./machine.js";
export type { MachineDeps, RunResult } from "./machine.js";
export * from "./agentFactory.js";

// Case tools / tool registry used by the machine and tests.
export { ToolRegistry, ToolBudgetExceededError, DEFAULT_MAX_TOOL_CALLS } from "./toolsRegistry.js";
export type { McpGraphToolName } from "./toolsRegistry.js";
export { createEvidenceIdGen, runStandardGather, createFacts } from "./investigation.js";
export type { InvestigationFacts, GatherRuntime, EvidenceIdGen } from "./investigation.js";

// Lookup / pure modules (assessor, stop rule, planner, recommender, explainer).
export {
  assess,
  fallbackAssessmentProposal,
  finalizeAssessment,
  canonicalPattern,
  distinctEvidenceCategories,
  topFraudHypothesis,
  legitHypothesis,
  confidenceCap,
} from "./assess.js";
export { evaluateStop, describeEvaluateStop } from "./stopRule.js";
export type { StopRuleInput, StopRuleDecision, StopReason } from "./stopRule.js";
export { planEvidenceGathering, pickBestEvidenceRequest } from "./planner.js";
export type { EvidencePlan, ScoredRequest, PreferenceBand } from "./planner.js";
export { recommendActions, summarizeChange } from "./recommend.js";
export type { Recommendations } from "./recommend.js";
export { buildExplanation } from "./explain.js";
export type { Explanation } from "./explain.js";
export { buildContextBundle, renderContextBundle } from "./contextBuilder.js";
export { buildCaseStateForPolicy } from "./caseState.js";

// LLM + MCP plumbing.
export { MockLlmClient, OllamaLlmClient, script } from "./llm.js";
export type { LlmClient, LlmCall, LlmResult, MockScriptEntry } from "./llm.js";
export { FakeMcpClient, RealMcpClient, createMcpClient, MCP_GRAPH_TOOL_NAMES } from "./mcpClient.js";
export type { McpClient, McpClientConfig } from "./mcpClient.js";
export { structuredCall, describeSchema, estimateTokens } from "./structured.js";
export type { StructuredCallOptions, StructuredCallResult } from "./structured.js";
export { EventLog } from "./events.js";
export { SCORER_PATTERNS, PATTERN_QUESTION, renderScorerState, applyPatternScore, SystemOneScorer, patternScorerFromEnv } from "./patternScorer.js";
export type { ScorerPattern, PatternScore, PatternScorer } from "./patternScorer.js";
