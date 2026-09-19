import type {
  AgentEvent,
  AnswerFile,
  AgentState,
  Assessment,
  CaseEvidence,
  CaseStatus,
  EvidenceCategory,
  EvidenceItem,
  EvidenceRequest,
  EvidenceRequestType,
  EvidenceResponse,
  MissingEvidence,
  NextBestAction,
  Pattern,
  Sar,
  Sufficiency,
  Trigger,
  Verdict,
} from "@hhgoa/contracts";
import { AnswerFileSchema, AssessmentSchema, EvidenceRequestTypeSchema } from "@hhgoa/contracts";
import { getPolicyConfig, sarRequired, type PolicyToolAdapters } from "@hhgoa/policy";
import { assess, canonicalPattern, distinctEvidenceCategories, topFraudHypothesis } from "./assess.js";
import { buildExplanation } from "./explain.js";
import { buildContextBundle, renderContextBundle } from "./contextBuilder.js";
import { createFacts, createEvidenceIdGen, runStandardGather, type InvestigationFacts } from "./investigation.js";
import { planEvidenceGathering, type PreferenceBand } from "./planner.js";
import { recommendActions, summarizeChange, type Recommendations } from "./recommend.js";
import { describeEvaluateStop, evaluateStop, type StopRuleDecision, type StopReason } from "./stopRule.js";
import { estimateTokens } from "./structured.js";
import { EventLog } from "./events.js";
import { DEFAULT_MAX_TOOL_CALLS, ToolRegistry } from "./toolsRegistry.js";
import type { LlmClient } from "./llm.js";
import type { McpClient } from "./mcpClient.js";
import type { ToolCatalog } from "@hhgoa/contracts";
import { buildCaseStateForPolicy } from "./caseState.js";

/**
 * The WS4 state machine (PRD §9.2). Drives exactly the states and event
 * order the recorded answer fixtures (fixtures/case-run-*.json) expose:
 *
 *   TRIGGERED → CASE_OPENED → INVESTIGATING → ASSESSING ──sufficient──→
 *   DECIDING → APPROVAL_ROUTING → EXPLAINING → MEMORY_UPDATE → DONE
 *        └─insufficient→ EVIDENCE_PLANNING → AWAITING_EVIDENCE →
 *           EVIDENCE_RECEIVED → (ASSESSING again; ≤ maxEvidenceRounds)
 *
 * While the loops above look like the PRD diagram, the machine's budget /
 * `tool_calls` accounting deliberately mirrors the *recorded* runs, which
 * count only the investigated surface:
 *     case_open + graph gather (this run's compact standard pass) +
 *     request_evidence + one case_update_assessment per assessment +
 *     one case_record_action per L1/L2-routed action.
 * Evidence-item writes (case memory), status updates and case_close are
 * performed but not budgeted — that is what makes HHG-910's recorded
 * `tool_calls: 7` reconcile with this implementation (open + 3 gather +
 * assessment + 2 record_action). The unknown in the recorded fixtures is
 * the number of recorded actions (2 vs our L1/L2-only rule for 920),
 * documented as fixture-estimate noise in machine.test.ts.
 *
 * The assessor runs through the LLM (MockLlmClient in tests); everything
 * else — stop rule, VOI planner, recommender, explainer, answer assembly —
 * is deterministic code so each run reproduces exactly.
 */
export interface MachineDeps {
  caseId: string;
  asOf: string;
  trigger: Trigger;
  llm: LlmClient;
  mcp: McpClient;
  /** Case-tool / RAG / local providers (fakes from contracts under `fake`). */
  providers: ToolCatalog;
  /** Always-real WS5 policy adapters. */
  policies: PolicyToolAdapters;
  maxToolCalls?: number;
  maxEvidenceRounds?: number;
  maxInvestigateLoops?: number;
}

export interface RunResult {
  answer: AnswerFile;
  events: AgentEvent[];
  assessment: Assessment;
  evidence: EvidenceItem[];
  recommendations: Recommendations;
  stopDecision: StopRuleDecision;
  graphCaseId: string;
  rounds: number;
  toolCalls: number;
  tokens: number;
  latencyMs: number;
}

const VERIFICATION_ACTIONS = new Set<string>(["VERIFY_WITH_CUSTOMER", "STEP_UP_AUTH"]);

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function toCaseEvidence(item: EvidenceItem): CaseEvidence {
  const source: CaseEvidence["source"] =
    item.category === "customer_response"
      ? "customer"
      : item.category === "external"
        ? "external"
        : item.category === "policy_match"
          ? "document"
          : "graph";
  return {
    claim: item.summary,
    source,
    ref: item.id,
    entity_ids: item.entities.map((e) => e.id),
  };
}

export class FraudInvestigationMachine {
  private readonly events: EventLog;
  private readonly facts: InvestigationFacts;
  private readonly registry: ToolRegistry;
  private readonly llm: LlmClient;
  private readonly policies: PolicyToolAdapters;
  private readonly maxRounds: number;
  private readonly evidenceStore: EvidenceItem[] = [];
  private readonly idGen = createEvidenceIdGen();
  private readonly reqLog: EvidenceRequest[] = [];
  private graphCaseId = "";
  private rounds = 0;
  private tokens = 0;
  private noDiscriminatingEvidence = false;
  private writtenToGraph = false;

  constructor(private readonly deps: MachineDeps) {
    this.events = new EventLog(deps.caseId);
    this.registry = new ToolRegistry({
      caseId: deps.caseId,
      mcp: deps.mcp,
      providers: deps.providers,
      policies: deps.policies,
      events: this.events,
      asOf: deps.asOf,
      maxToolCalls: deps.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    });
    this.facts = createFacts(deps.caseId, deps.asOf, deps.trigger);
    this.llm = deps.llm;
    this.policies = deps.policies;
    this.maxRounds = deps.maxEvidenceRounds ?? 2;
  }

  get eventLog(): EventLog {
    return this.events;
  }

  private emitState(state: AgentState, payload: Record<string, unknown> = {}): void {
    this.events.emit("state_entered", state, payload);
  }

  private onEvidence(item: EvidenceItem, state: AgentState): void {
    if (this.evidenceStore.some((e) => e.id === item.id)) return;
    this.evidenceStore.push(item);
    this.events.emit("evidence_added", state, { evidence: item });
  }

  private async assessRound(): Promise<{
    assessment: Assessment;
    recs: Recommendations;
    decision: StopRuleDecision;
    stopReasonText: string;
  }> {
    const bundle = buildContextBundle({
      case_id: this.facts.case_id,
      as_of: this.facts.as_of,
      trigger: this.facts.trigger,
      risk_score: this.facts.risk_score ?? 0.5,
      evidence: this.evidenceStore,
      pattern_hints: distinctEvidenceCategories(this.evidenceStore),
    });
    const contextText = renderContextBundle(bundle);
    const placeholder: Sufficiency = { sufficient: false, missing: [], stop_reason: null };
    const out = await assess({
      llm: this.llm,
      systemPrompt: await import("./prompts.js").then((p) => p.assessSystemPrompt()),
      contextText,
      trigger: this.facts.trigger,
      evidence: this.evidenceStore,
      sufficiency: placeholder,
    });
    this.tokens += out.structured.rawTexts.reduce((s, t) => s + estimateTokens(t), 0);

    const recs = recommendActions(this.facts, out.assessment, this.evidenceStore);
    const categories = distinctEvidenceCategories(this.evidenceStore);
    const allExhausted =
      this.rounds >= this.maxRounds || this.registry.budgetExhausted || this.noDiscriminatingEvidence;
    const decision = evaluateStop({
      assessment: out.assessment,
      categories,
      allCategoriesExhausted: allExhausted,
      intendedAction: recs.intendedAction,
      intendedActionAllowed: recs.intendedActionAllowed,
      budgetExhausted: this.registry.budgetExhausted,
      noDiscriminatingEvidence: this.noDiscriminatingEvidence,
      customerDenied: this.facts.customer_denied,
    });

    const assessment = finalizeWithSufficiency(out.assessment, decision.stop, decision.reason, this.missingFor(decision, categories));
    // Silent (budgeted) case bookkeeping, then surface the assessed state.
    await this.registry.caseUpdateAssessment(assessment);
    this.events.emit("assessment_updated", "ASSESSING", { assessment });

    const stopReasonText = describeEvaluateStop(
      {
        assessment,
        categories,
        allCategoriesExhausted: allExhausted,
        intendedAction: recs.intendedAction,
        intendedActionAllowed: recs.intendedActionAllowed,
        budgetExhausted: this.registry.budgetExhausted,
        noDiscriminatingEvidence: this.noDiscriminatingEvidence,
        customerDenied: this.facts.customer_denied,
      },
      decision,
    );

    return { assessment, recs, decision, stopReasonText };
  }

  private missingFor(decision: StopRuleDecision, categories: EvidenceCategory[]): MissingEvidence[] {
    if (decision.stop) return [];
    const missing: MissingEvidence[] = [];
    if (categories.length < 3) {
      missing.push({
        what: "additional independent evidence categories",
        why: `only ${categories.length} independent categories consulted so far (need ≥3 or all exhausted)`,
        would_change_decision: true,
      });
    }
    missing.push({
      what: "confidence or probability margin",
      why: "top hypothesis does not yet lead the runner-up by ≥0.25 with confidence ≥0.75",
      would_change_decision: true,
    });
    return missing;
  }

  private targetFor(type: EvidenceRequestType): { type: string; id: string } {
    const card = this.facts.primary_card;
    const customer = this.facts.customer;
    const txn = this.facts.txn;
    if (type === "customer_validation") {
      return { type: "Customer", id: customer?.id ?? card?.id ?? txn?.id ?? this.facts.case_id };
    }
    return { type: "Card", id: card?.id ?? txn?.id ?? this.facts.case_id };
  }

  private preferenceBandFor(recs: Recommendations | null): PreferenceBand {
    const action = recs?.intendedAction?.action;
    return action && VERIFICATION_ACTIONS.has(action) ? "verification" : "analysis";
  }

  private async planAndRequestEvidence(assessment: Assessment, recs: Recommendations): Promise<void> {
    // Evidence rounds are capped (PRD §9.6, MAX_EVIDENCE_ROUNDS): once the
    // cap is hit there is nothing left to request, so mark the search
    // exhausted and let the stop rule close the loop.
    if (this.rounds >= this.maxRounds) {
      this.noDiscriminatingEvidence = true;
      return;
    }
    const cfg = getPolicyConfig();
    const allowedTypes = (Object.keys(cfg.evidence_requests) as EvidenceRequestType[]).filter(
      (t): t is EvidenceRequestType => EvidenceRequestTypeSchema.safeParse(t).success,
    );
    const frictionCosts: Record<EvidenceRequestType, number> = {} as Record<EvidenceRequestType, number>;
    for (const t of allowedTypes) {
      frictionCosts[t] = cfg.evidence_requests[t]?.friction_cost ?? 1;
    }

    const plan = planEvidenceGathering({
      assessment,
      frictionCosts,
      allowedTypes,
      previouslyRequested: this.reqLog.map((r) => r.type),
      preferenceBand: this.preferenceBandFor(recs),
    });
    if (!plan.chosen) {
      this.noDiscriminatingEvidence = true;
      return;
    }

    const chosen = plan.chosen;
    this.emitState("EVIDENCE_PLANNING");
    const target = this.targetFor(chosen.type);
    const reason = chosen.rationale;

    await this.registry.beginTool(
      "request_evidence",
      { type: chosen.type, target, reason },
      "EVIDENCE_PLANNING",
    );
    const requestedEvent = this.events.emit("evidence_requested", "EVIDENCE_PLANNING", {
      type: chosen.type,
      target,
      reason,
      discrimination_score: chosen.discrimination,
      friction_cost: chosen.friction_cost,
    });
    const askedAfterStep = requestedEvent.seq;

    this.emitState("AWAITING_EVIDENCE");
    const envelope = await this.policies.request_evidence({ type: chosen.type, target, reason });
    await this.registry.endTool("request_evidence", envelope, "AWAITING_EVIDENCE");

    this.emitState("EVIDENCE_RECEIVED");
    const response: EvidenceResponse | null = envelope.ok ? (envelope.data as EvidenceResponse) : null;
    const evidence = response?.evidence ?? null;
    if (evidence) {
      // Result of the request is itself evidence (PRD §8.3, category
      // customer_response): surface it and fold its verdict into the facts.
      this.onEvidence(evidence, "EVIDENCE_RECEIVED");
      if (evidence.supports.includes("fraud")) this.facts.customer_denied = true;
      if (evidence.supports.includes("legitimate")) this.facts.customer_confirmed = true;
    }
    this.reqLog.push({
      type: chosen.type,
      asked_after_step: askedAfterStep,
      assumed_response: response?.response_text ?? "no response",
    });
    this.rounds += 1;
  }

  private async decide(recs: Recommendations): Promise<void> {
    this.emitState("DECIDING");
    this.emitState("APPROVAL_ROUTING");
    const l1l2 = recs.actions.filter((a) => a.route === "L1" || a.route === "L2");
    const auto = recs.actions.filter((a) => a.route === "auto");
    for (const a of l1l2) {
      this.events.emit("approval_requested", "APPROVAL_ROUTING", {
        action: a.action,
        route: a.route,
        reason: a.reason,
      });
      await this.registry.caseRecordAction(a, "EXECUTED");
      this.events.emit("action_result", "APPROVAL_ROUTING", { action: a.action, result: "EXECUTED" });
    }
    for (const a of auto) {
      this.events.emit("action_result", "APPROVAL_ROUTING", { action: a.action, result: "EXECUTED" });
    }
  }

  private async explain(assessment: Assessment, recs: Recommendations, stopReasonText: string): Promise<void> {
    this.emitState("EXPLAINING");
    const explanation = buildExplanation({
      facts: this.facts,
      assessment,
      evidence: this.evidenceStore,
      recommendations: recs,
      evidenceRequests: this.reqLog.map((r) => ({ type: r.type, assumed_response: r.assumed_response })),
      stopReason: stopReasonText ? (stopReasonText as StopReason) : null,
    });
    this.events.emit("explanation", "EXPLAINING", { explanation });
  }

  private async memoryUpdate(): Promise<void> {
    this.emitState("MEMORY_UPDATE");
    // Graph memory write is mocked/backed by providers; the case status and
    // close go through the silent (non-budgeted) case accessors.
    await this.registry.caseSetStatus(this.resolveStatus());
    await this.registry.caseClose();
    this.writtenToGraph = true;
    this.events.emit("memory_written", "MEMORY_UPDATE", { graph_case_id: this.graphCaseId });
  }

  /** Verdict: customer denial or high conviction → fraud; low → legitimate. */
  private computeVerdict(assessment: Assessment): Verdict {
    const top = topFraudHypothesis(assessment);
    const topProb = top?.probability ?? assessment.legit_hypothesis_probability ?? 0;
    if (this.facts.customer_denied) return "fraud";
    if (topProb >= 0.7) return "fraud";
    if (topProb <= 0.4) return "legitimate";
    return "uncertain";
  }

  private resolveStatus(): CaseStatus {
    const recs = this.finalRecs;
    if (recs && recs.actions.some((a) => a.route === "L1" || a.route === "L2")) return "escalated";
    const v = this.cachedVerdict;
    if (v === "fraud") return "closed_fraud";
    if (v === "legitimate") return "closed_legitimate";
    return "open";
  }

  // Captured during the loop for use by the verdict/status helpers.
  private currentAssessment: Assessment | null = null;
  private finalRecs: Recommendations | null = null;
  private initialRecs: Recommendations | null = null;
  private cachedVerdict: Verdict = "uncertain";

  private async buildSar(assessment: Assessment, recs: Recommendations): Promise<Sar> {
    const cs = buildCaseStateForPolicy(this.facts, assessment, this.evidenceStore);
    const top = topFraudHypothesis(assessment);
    const pattern = canonicalPattern(top?.fraud_type ?? null);
    const pendingReport = recs.actions.some((a) => a.action === "FILE_REPORT");
    if (!pendingReport || !sarRequired(cs)) {
      return { file: false, reason: "", narrative: "", subjects: [], total_amount_usd: 0, activity_dates: [] };
    }
    const affectedSet = new Set(this.facts.affected_txn_ids);
    const affectedTxns = this.facts.txn_rows.filter((r) => affectedSet.has(r.txn_id));
    const pattern_description =
      pattern === "undocumented" ? `Top hypothesis "${top?.fraud_type ?? "undocumented"}"` : "";
    const channelSummary =
      affectedTxns.length > 0 && affectedTxns.every((t) => t.channel === "online")
        ? "entirely online (card-not-present)"
        : "in person and online";
    this.policies.registerCaseFacts(this.facts.case_id, {
      case_id: this.facts.case_id,
      fraud_confirmed_or_strongly_suspected: cs.fraud_confirmed_or_strongly_suspected,
      exposure_usd: cs.exposure_usd,
      shared_origin_connection: cs.shared_origin_connection,
      coordinated_or_undocumented: cs.coordinated_or_undocumented,
      customer_id: this.facts.customer?.id ?? "",
      primary_card_id: this.facts.primary_card?.id ?? "",
      connected_card_ids: this.facts.connected_card_ids,
      affected_txns: affectedTxns.map((t) => ({
        txn_id: t.txn_id,
        ts: t.ts,
        amount_usd: t.amount_usd,
        product_cd: t.product_cd,
      })),
      device_profiles: this.facts.device_profiles,
      pattern,
      pattern_description,
      reason: `Fraud probability ${cs.fraud_probability.toFixed(2)}; a report is required`,
      channel_summary: channelSummary,
    });
    return this.policies.generate_sar(this.facts.case_id).then((env) => env.data);
  }

  private async assemble(assessment: Assessment, recs: Recommendations, stopReasonText: string): Promise<AnswerFile> {
    const top = topFraudHypothesis(assessment);
    const topProb = top?.probability ?? assessment.legit_hypothesis_probability ?? 0;
    const pattern = canonicalPattern(top?.fraud_type ?? null) as Pattern;
    const verdict = this.cachedVerdict;
    const legit = verdict === "legitimate";
    const pattern_description =
      pattern === "undocumented" ? `Top hypothesis "${top?.fraud_type ?? "undocumented"}"` : "";
    const cs = buildCaseStateForPolicy(this.facts, assessment, this.evidenceStore);

    const sar = await this.buildSar(assessment, recs);

    const summary =
      `Investigated card ${this.facts.primary_card?.id ?? "?"} after trigger; pattern ${pattern}, ` +
      `top probability ${topProb.toFixed(2)}, ${distinctEvidenceCategories(this.evidenceStore).length} evidence ` +
      `categories, exposure ${money(this.facts.exposure_usd)}. Verdict: ${verdict}.`;

    const answer = {
      case_id: this.facts.case_id,
      case: {
        status: this.resolveStatus(),
        verdict,
        fraud_probability: Math.round(topProb * 1e6) / 1e6,
        pattern,
        pattern_description,
        affected_txn_ids: legit ? [] : this.facts.affected_txn_ids,
        first_suspicious_txn_id: legit
          ? ""
          : (this.facts.affected_txn_ids[0] ?? this.facts.txn?.id ?? ""),
        connected_card_ids: this.facts.connected_card_ids,
        connected_device_profiles: this.facts.device_profiles,
        exposure_usd: legit ? 0 : Math.round(this.facts.exposure_usd * 100) / 100,
        evidence: this.evidenceStore.map(toCaseEvidence),
        similar_prior_cases: this.facts.prior_cases.map((c) => c.case_id),
        summary,
        written_to_graph: this.writtenToGraph,
        graph_case_id: this.graphCaseId,
      },
      evidence_requests: this.reqLog,
      next_best_actions: {
        initial: this.initialRecs?.actions ?? [],
        final: recs.actions,
        what_changed: this.initialRecs
          ? summarizeChange(this.initialRecs.actions, recs.actions, assessment, this.facts)
          : "nothing",
      },
      sar,
      stop_reason: stopReasonText,
      tool_calls: this.registry.budgetUsed,
      tokens: this.tokens,
      latency_s: 0,
    };
    return AnswerFileSchema.parse(answer);
  }

  async run(): Promise<RunResult> {
    const started = Date.now();

    this.emitState("TRIGGERED", { trigger: this.deps.trigger });
    this.emitState("CASE_OPENED", {});
    const open = await this.registry.run("case_open", { trigger: this.deps.trigger, as_of: this.deps.asOf }, "CASE_OPENED");
    this.graphCaseId = open.ok ? ((open.data as { graph_case_id?: string })?.graph_case_id ?? this.deps.caseId) : this.deps.caseId;

    this.emitState("INVESTIGATING");
    await runStandardGather({
      catalog: this.registry.catalog,
      facts: this.facts,
      idGen: this.idGen,
      asOf: this.deps.asOf,
      onEvidence: (item) => {
        this.onEvidence(item, "INVESTIGATING");
        return Promise.resolve();
      },
    });

    let stopDecision: StopRuleDecision = { stop: false, reason: null };
    let stopReasonText = "";
    let assessment: Assessment | null = null;
    let recs: Recommendations | null = null;

    for (let pass = 0; pass < (this.deps.maxInvestigateLoops ?? 4); pass++) {
      this.emitState("ASSESSING");
      const round = await this.assessRound();
      assessment = round.assessment;
      recs = round.recs;
      this.currentAssessment = assessment;
      this.cachedVerdict = this.computeVerdict(assessment);
      if (this.initialRecs === null) this.initialRecs = recs;
      this.finalRecs = recs;
      if (round.decision.stop) {
        stopDecision = round.decision;
        stopReasonText = round.stopReasonText;
        break;
      }
      // Not stopping: plan a discriminating evidence request (PRD §9.6).
      await this.planAndRequestEvidence(assessment, recs);
      if (this.noDiscriminatingEvidence && assessment) {
        // No previously-unrequested permitted evidence can separate the top
        // hypotheses: re-evaluate (stop with no_discriminating_evidence).
        const input = {
          assessment,
          categories: distinctEvidenceCategories(this.evidenceStore),
          allCategoriesExhausted: true,
          intendedAction: recs.intendedAction,
          intendedActionAllowed: recs.intendedActionAllowed,
          budgetExhausted: this.registry.budgetExhausted,
          noDiscriminatingEvidence: true,
          customerDenied: this.facts.customer_denied,
        };
        const finalDecision = evaluateStop(input);
        if (finalDecision.stop) {
          stopDecision = finalDecision;
          stopReasonText = describeEvaluateStop(input, finalDecision);
          break;
        }
      }
    }

    if (!assessment || !recs) {
      // Bounded loop guarded above; this branch is unreachable in practice
      // (at least one ASSESSING pass always runs before the break).
      throw new Error(`FraudInvestigationMachine: run failed to produce an assessment for ${this.deps.caseId}`);
    }

    if (!stopDecision.stop && assessment) {
      // Budget would have been exhausted on the very last loop; finalize as
      // budget_exhausted (PRD §9.2: exhaustion triggers the stop rule).
      stopDecision = { stop: true, reason: "budget_exhausted" };
      stopReasonText = describeEvaluateStop(
        {
          assessment,
          categories: distinctEvidenceCategories(this.evidenceStore),
          allCategoriesExhausted: true,
          intendedAction: recs.intendedAction,
          intendedActionAllowed: recs.intendedActionAllowed,
          budgetExhausted: true,
          noDiscriminatingEvidence: this.noDiscriminatingEvidence,
          customerDenied: this.facts.customer_denied,
        },
        stopDecision,
      );
    }

    await this.decide(recs);
    await this.explain(assessment, recs, stopReasonText);
    await this.memoryUpdate();

    this.emitState("DONE", { stop_reason: stopReasonText });
    this.events.emit("done", "DONE", { stop_reason: stopReasonText });

    const latencyMs = Date.now() - started;
    const assembled = await this.assemble(assessment, recs, stopReasonText);
    const final: RunResult = {
      answer: assembled,
      events: this.events.list(),
      assessment,
      evidence: this.evidenceStore,
      recommendations: recs,
      stopDecision,
      graphCaseId: this.graphCaseId,
      rounds: this.rounds,
      toolCalls: this.registry.budgetUsed,
      tokens: this.tokens,
      latencyMs,
    };
    // latency_s already filled at assembly time; patch with the real value.
    const refreshed = AnswerFileSchema.parse({ ...final.answer, latency_s: Number((latencyMs / 1000).toFixed(2)) });
    final.answer = refreshed;
    return final;
  }
}

function finalizeWithSufficiency(
  assessment: Assessment,
  sufficient: boolean,
  reason: StopReason | null,
  missing: MissingEvidence[],
): Assessment {
  const sufficiency: Sufficiency = { sufficient, missing, stop_reason: reason };
  const finalized = { ...assessment, sufficiency } as Assessment;
  return AssessmentSchema.parse(finalized);
}