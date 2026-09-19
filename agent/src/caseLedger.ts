import type {
  Assessment,
  CaseStatus,
  Decision,
  EvidenceItem,
  ExecuteActionResult,
  Finding,
  NextBestAction,
  ToolCatalog,
  ToolResult,
  Trigger,
} from "@hhgoa/contracts";

/**
 * Real (in-memory, process-local) case ledger backing the 8 `case_*` tools
 * under `TOOLS_BACKEND=real`. Scoped deliberately to in-memory bookkeeping,
 * not a TigerGraph write: persisting live investigation cases as graph
 * vertices would be a schema/architecture decision of its own (`contracts/`
 * is frozen post-M0, and WS2 already found `ALTER GRAPH` unsupported on this
 * build — see docs/decisions.md), not something this integration pass makes
 * unilaterally. `graph_case_id` here is therefore a synthetic id, not a real
 * graph vertex reference — a case's actual graph evidence still comes from
 * the real MCP/GSQL reads the other 10 tools do.
 *
 * One ledger instance is created per `runAgent()` call (see agentFactory.ts)
 * and only lives for that run, mirroring how `contracts/src/fakes.ts`'s
 * case_* tools are stateless per call — the difference is this one actually
 * accumulates what the machine records instead of returning a canned fixture.
 *
 * Case identity is assigned by the caller, not generated here: every case_*
 * call after `case_open` reaches this ledger via `ToolRegistry`'s silent
 * accessors (`caseUpdateAssessment` etc., toolsRegistry.ts), which always
 * key off `RunAgentOptions.caseId` — they never look at what `case_open`
 * returned. So the ledger is constructed with that same known case id up
 * front and `case_open` opens a record under it, rather than minting its own
 * id that nothing downstream would ever use (a real bug caught live: every
 * post-open call threw "unknown case_id" until this was fixed).
 */

export interface CaseRecord {
  case_id: string;
  graph_case_id: string;
  trigger: Trigger;
  opened_at: string;
  status: CaseStatus;
  evidence: EvidenceItem[];
  findings: Finding[];
  assessments: Assessment[];
  decisions: Decision[];
  actions: Array<{ action: NextBestAction; status: ExecuteActionResult }>;
  closed_at?: string;
}

function ack<T>(tool: string, as_of: string, data: T): Promise<ToolResult<T>> {
  return Promise.resolve({
    ok: true,
    tool,
    as_of,
    via: "local",
    data,
    evidence_refs: [],
    truncated: false,
    latency_ms: 0,
    error: null,
  });
}

export class InMemoryCaseLedger {
  private readonly cases = new Map<string, CaseRecord>();

  constructor(private readonly caseId: string) {}

  private require(case_id: string): CaseRecord {
    const found = this.cases.get(case_id);
    if (!found) throw new Error(`InMemoryCaseLedger: unknown case_id "${case_id}"`);
    return found;
  }

  get(case_id: string): CaseRecord {
    return this.require(case_id);
  }

  readonly case_open: ToolCatalog["case_open"] = async (trigger, as_of) => {
    const case_id = this.caseId;
    const graph_case_id = `GRAPH-${case_id}`;
    this.cases.set(case_id, {
      case_id,
      graph_case_id,
      trigger,
      opened_at: as_of,
      status: "open",
      evidence: [],
      findings: [],
      assessments: [],
      decisions: [],
      actions: [],
    });
    return ack("case_open", as_of, { case_id, graph_case_id });
  };

  readonly case_add_evidence: ToolCatalog["case_add_evidence"] = async (case_id, evidence, as_of) => {
    this.require(case_id).evidence.push(evidence);
    return ack("case_add_evidence", as_of, { case_id, ok: true as const });
  };

  readonly case_add_finding: ToolCatalog["case_add_finding"] = async (case_id, finding, as_of) => {
    this.require(case_id).findings.push(finding);
    return ack("case_add_finding", as_of, { case_id, ok: true as const });
  };

  readonly case_update_assessment: ToolCatalog["case_update_assessment"] = async (case_id, assessment, as_of) => {
    this.require(case_id).assessments.push(assessment);
    return ack("case_update_assessment", as_of, { case_id, ok: true as const });
  };

  readonly case_record_decision: ToolCatalog["case_record_decision"] = async (case_id, decision, as_of) => {
    this.require(case_id).decisions.push(decision);
    return ack("case_record_decision", as_of, { case_id, ok: true as const });
  };

  readonly case_record_action: ToolCatalog["case_record_action"] = async (case_id, action, status, as_of) => {
    this.require(case_id).actions.push({ action, status });
    return ack("case_record_action", as_of, { case_id, ok: true as const });
  };

  readonly case_set_status: ToolCatalog["case_set_status"] = async (case_id, status, as_of) => {
    this.require(case_id).status = status;
    return ack("case_set_status", as_of, { case_id, ok: true as const });
  };

  readonly case_close: ToolCatalog["case_close"] = async (case_id, as_of) => {
    this.require(case_id).closed_at = as_of;
    return ack("case_close", as_of, { case_id, ok: true as const });
  };
}
