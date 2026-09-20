import type { AgentEvent, AnswerFile, Trigger } from "@hhgoa/contracts";
import { AgentEventSchema } from "@hhgoa/contracts";
import type { RunAgentOptions } from "@hhgoa/agent";
import { CASE_PACK, type CasePackEntry } from "./data/casePack.js";
import type { RunRecording, RunSource } from "./runSource.js";
import type { ExternalAgentEvent, LiveFeed, SessionStatus, Subscriber } from "./replaySession.js";

/**
 * A case the live source knows how to run: the WS4 machine needs exactly
 * `caseId + asOf + trigger` (PRD §9.2) — everything else is env-defaulted.
 */
export interface LiveRunUnit {
  caseId: string;
  trigger: Trigger;
  asOf: string;
}

/**
 * Starts a live investigation and forwards every emitted `AgentEvent` to
 * `onEvent` as it happens. The default is `machineRunner` (the real WS4
 * machine); tests inject a fake to simulate streaming runs.
 */
export type LiveRunner = (
  options: RunAgentOptions,
  onEvent: (event: AgentEvent) => void,
) => Promise<{ answer: AnswerFile }>;

interface RunningCase {
  status: SessionStatus;
  events: AgentEvent[];
  answer: AnswerFile | null;
  error: string | null;
  subscribers: Set<Subscriber>;
}

/**
 * Maps one case-pack entry (docs/DATA_MAP.md, the 20 benchmark cases
 * transcribed byte-identical from docs/DATASET_README.md) into the `Trigger`
 * the WS4 machine consumes (PRD §8.4), so a live run starts from exactly the
 * recorded trigger fields.
 */
export function buildTriggerFromCasePack(entry: CasePackEntry): Trigger {
  switch (entry.trigger_type) {
    case "risk_score":
      return {
        kind: "risk_score",
        txn_id: entry.flagged_txn_id,
        card_id: entry.card_id,
        risk_score: entry.risk_score ?? 0.5,
      };
    case "customer_report":
      return {
        kind: "customer_report",
        customer_id: entry.customer_id,
        txn_ids: entry.flagged_txn_id ? [entry.flagged_txn_id] : undefined,
        text: entry.trigger_text,
      };
    case "analyst_request":
      return {
        kind: "analyst_request",
        entity: { type: "Card", id: entry.card_id },
        question: entry.trigger_text,
      };
  }
}

function defaultUnits(): LiveRunUnit[] {
  return CASE_PACK.map((entry) => ({
    caseId: entry.case_id,
    trigger: buildTriggerFromCasePack(entry),
    asOf: entry.opened_at,
  }));
}

/**
 * Runs the real WS4 agent for one case and forwards every `AgentEvent` to
 * `onEvent` as the machine emits it. Services default from the environment
 * exactly like `runAgent` does (agent/src/agentFactory.ts): fake MCP + mock
 * LLM unless `TOOLS_BACKEND=real` / `LLM_BACKEND=ollama|openai`.
 *
 * The `@hhgoa/agent` import is dynamic so a fixture-only server (the
 * default) never loads WS4's module graph.
 */
function llmBackendFromEnv(): "mock" | "ollama" | "openai" {
  const llm = process.env.LLM_BACKEND;
  if (llm === "ollama" || llm === "openai") return llm;
  return "mock";
}

async function machineRunner(
  options: RunAgentOptions,
  onEvent: (event: AgentEvent) => void,
): Promise<{ answer: AnswerFile }> {
  const { FraudInvestigationMachine, createLlmClient, createMcpClient, createPolicyAdapters, createToolProviders } =
    await import("@hhgoa/agent");

  const backend = options.backend ?? (process.env.TOOLS_BACKEND === "real" ? "real" : "fake");
  const machine = new FraudInvestigationMachine({
    caseId: options.caseId,
    asOf: options.asOf,
    trigger: options.trigger,
    llm: options.llm ?? createLlmClient(llmBackendFromEnv()),
    mcp: options.mcp ?? createMcpClient(backend),
    providers: options.providers ?? (await createToolProviders(backend, options.caseId)),
    policies: options.policies ?? createPolicyAdapters(),
    maxToolCalls: options.maxToolCalls,
    maxEvidenceRounds: options.maxEvidenceRounds,
    maxInvestigateLoops: options.maxInvestigateLoops,
  });
  const unsubscribe = machine.eventLog.subscribe(onEvent);
  try {
    return await machine.run();
  } finally {
    unsubscribe();
  }
}

/**
 * `RunSource` implementation backed by the real agent, and the `LiveFeed`
 * that `LiveSession` (replaySession.ts) consumes. Runs are fire-and-forget:
 * `start()` launches the runner once per case (idempotent), events are
 * buffered and broadcast to subscribers, and a completed run materializes as
 * a `RunRecording` (null until `done`). Failures set status `error` and are
 * retryable by calling `start()` again. All state is in-memory, so a server
 * restart re-runs whatever case is next opened.
 */
export class LiveRunSource implements RunSource, LiveFeed {
  private readonly units = new Map<string, LiveRunUnit>();
  private readonly runs = new Map<string, RunningCase>();
  private readonly runner: LiveRunner;

  constructor(options: { units?: readonly LiveRunUnit[]; runner?: LiveRunner } = {}) {
    this.runner = options.runner ?? ((opts, onEvent) => machineRunner(opts, onEvent));
    for (const unit of options.units ?? defaultUnits()) {
      this.units.set(unit.caseId, unit);
    }
  }

  // --- RunSource ----------------------------------------------------

  listKnownCaseIds(): string[] {
    return [...this.units.keys()];
  }

  getRecording(caseId: string): RunRecording | null {
    const run = this.runs.get(caseId);
    if (!run || run.status !== "done" || !run.answer) return null;
    return { case_id: caseId, events: [...run.events], answer: run.answer };
  }

  // --- LiveFeed -------------------------------------------------------

  supports(caseId: string): boolean {
    return this.units.has(caseId);
  }

  getStatus(caseId: string): SessionStatus {
    if (!this.units.has(caseId)) return "idle";
    return this.ensureCase(caseId).status;
  }

  getEvents(caseId: string): AgentEvent[] {
    return [...this.ensureCase(caseId).events];
  }

  getLastError(caseId: string): string | null {
    return this.ensureCase(caseId).error;
  }

  /** Registers a case the machine can run (used for UI-submitted ad-hoc triggers). */
  registerAdhoc(caseId: string, trigger: Trigger, asOf: string = new Date().toISOString()): void {
    this.units.set(caseId, { caseId, trigger, asOf });
  }

  /**
   * Starts the run for a case if it isn't already running/done; a failed run
   * is reset so reopening the case retries from the trigger.
   */
  start(caseId: string): void {
    const unit = this.units.get(caseId);
    if (!unit) return;
    const run = this.ensureCase(caseId);
    if (run.status === "running" || run.status === "done") return;
    if (run.status === "error") {
      run.status = "idle";
      run.events = [];
      run.answer = null;
      run.error = null;
    }
    run.status = "running";
    void this.run(unit, run);
  }

  /** Replays the backlog to a new subscriber, then streams live events; starts the run. */
  subscribe(caseId: string, send: Subscriber): () => void {
    if (!this.units.has(caseId)) return () => {};
    const run = this.ensureCase(caseId);
    for (const event of run.events) send(event);
    run.subscribers.add(send);
    this.start(caseId);
    return () => {
      run.subscribers.delete(send);
    };
  }

  /** Appends an externally-produced event (synthetic approvals via `LiveSession`). */
  pushExternalEvent(caseId: string, event: ExternalAgentEvent): void {
    const run = this.ensureCase(caseId);
    const maxSeq = run.events.reduce((m, e) => Math.max(m, e.seq), -1);
    this.push(caseId, {
      ...event,
      seq: event.seq ?? maxSeq + 1,
      case_id: event.case_id ?? caseId,
    });
  }

  private async run(unit: LiveRunUnit, run: RunningCase): Promise<void> {
    try {
      const result = await this.runner(
        { caseId: unit.caseId, asOf: unit.asOf, trigger: unit.trigger },
        (event) => this.push(unit.caseId, event),
      );
      run.answer = result.answer;
      run.status = "done";
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      run.status = "error";
    }
  }

  private ensureCase(caseId: string): RunningCase {
    let run = this.runs.get(caseId);
    if (!run) {
      run = { status: "idle", events: [], answer: null, error: null, subscribers: new Set() };
      this.runs.set(caseId, run);
    }
    return run;
  }

  private push(caseId: string, event: AgentEvent): void {
    const run = this.runs.get(caseId);
    if (!run) return;
    const parsed = AgentEventSchema.parse(event);
    run.events.push(parsed);
    for (const sub of run.subscribers) sub(parsed);
  }
}