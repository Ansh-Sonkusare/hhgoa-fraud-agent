import type {
  PolicyCheck,
  ExecuteAction,
  RequestEvidence,
  GenerateSar,
  ApprovalChannel,
  EvidenceResponder,
  ToolResult,
  Sar,
} from "@hhgoa/contracts";
import { policyCheck, executeAction, sarRequired } from "./engine.js";
import { getPolicyConfig } from "./loadPolicy.js";
import { buildSar, type SarInputFacts } from "./sar.js";
import { CaseStateForPolicySchema, type ExecuteActionParams } from "./types.js";
import type { ActionsMock } from "./actionsMock.js";

/**
 * Adapts `engine.ts` / `sar.ts` / `actionsMock.ts` to the exact
 * `ToolCatalog` function signatures in `contracts/src/tools.ts`, so
 * `agent/src/toolsRegistry.ts` can plug these straight in as
 * `policy_check` / `execute_action` / `request_evidence` / `generate_sar`
 * regardless of `TOOLS_BACKEND` — the policy engine is WS5's own code, not
 * blocked on WS1/WS3, so it is always "real" even while graph/RAG tools run
 * against fakes.
 */
export interface PolicyToolAdaptersDeps {
  approvalChannel: ApprovalChannel;
  actionsMock: ActionsMock;
  responder: EvidenceResponder;
}

export interface PolicyToolAdapters {
  policy_check: PolicyCheck;
  execute_action: ExecuteAction;
  request_evidence: RequestEvidence;
  generate_sar: GenerateSar;
  /** Must be called before `generate_sar(case_id)` can succeed for that case. */
  registerCaseFacts(case_id: string, facts: SarInputFacts): void;
}

function envelope<T>(tool: string, via: "policy", data: T, latency_ms: number): ToolResult<T> {
  return {
    ok: true,
    tool,
    as_of: "n/a",
    via,
    data,
    evidence_refs: [],
    truncated: false,
    latency_ms,
    error: null,
  };
}

export function createPolicyToolAdapters(deps: PolicyToolAdaptersDeps): PolicyToolAdapters {
  const sarFactsStore = new Map<string, SarInputFacts>();

  const policy_check: PolicyCheck = async (input) => {
    const start = Date.now();
    const cs = CaseStateForPolicySchema.parse(input.case_state);
    const result = policyCheck(input.action_or_request, cs);
    return envelope("policy_check", "policy", result, Date.now() - start);
  };

  const execute_action: ExecuteAction = async (input) => {
    const start = Date.now();
    // input.params is Record<string, unknown> per the frozen contract;
    // validated here (never trusted as-is) rather than cast.
    const parsedCaseState = CaseStateForPolicySchema.parse(input.params["case_state"]);
    const rawReason = input.params["reason"];
    const reason = typeof rawReason === "string" ? rawReason : "";
    const execParams: ExecuteActionParams = { case_state: parsedCaseState, reason };
    const outcome = await executeAction(input.action, execParams, {
      approvalChannel: deps.approvalChannel,
      actionsMock: deps.actionsMock,
    });
    const latency_ms = Date.now() - start;
    return {
      ok: outcome.result !== "DENIED",
      tool: "execute_action",
      as_of: "n/a",
      via: "policy",
      data: { result: outcome.result },
      evidence_refs: [],
      truncated: false,
      latency_ms,
      error: outcome.reason ?? null,
    };
  };

  const request_evidence: RequestEvidence = async (input) => {
    const start = Date.now();
    const cfg = getPolicyConfig();
    if (!(input.type in cfg.evidence_requests)) {
      throw new Error(`policy.yaml is missing an evidence_requests entry for "${input.type}"`);
    }
    const response = await deps.responder.respond(input);
    const latency_ms = Date.now() - start;
    return {
      ok: true,
      tool: "request_evidence",
      as_of: "n/a",
      via: "policy",
      data: response,
      evidence_refs: [response.evidence.id],
      truncated: false,
      latency_ms,
      error: null,
    };
  };

  const generate_sar: GenerateSar = async (case_id) => {
    const start = Date.now();
    const facts = sarFactsStore.get(case_id);
    if (!facts) {
      throw new Error(
        `generate_sar: no case facts registered for case_id "${case_id}" — call registerCaseFacts(case_id, facts) first`,
      );
    }
    const sar: Sar = buildSar(facts);
    const latency_ms = Date.now() - start;
    return envelope("generate_sar", "policy", sar, latency_ms);
  };

  return {
    policy_check,
    execute_action,
    request_evidence,
    generate_sar,
    registerCaseFacts(case_id, facts) {
      sarFactsStore.set(case_id, facts);
    },
  };
}

/** Re-exported for callers that just want the pure SAR-required test. */
export { sarRequired };
