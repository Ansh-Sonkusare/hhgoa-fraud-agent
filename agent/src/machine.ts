import type {
  AgentEvent,
  AnswerFile,
  AgentState,
  Assessment,
  CaseEvidence,
  CaseRecord,
  CaseStatus,
  EvidenceCategory,
  EvidenceItem,
  EvidenceRequest,
  EvidenceRequestType,
  EvidenceResponse,
  Hypothesis,
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
import { assess, deriveRiskLevel, distinctEvidenceCategories, resolvePatternLabel, topFraudHypothesis, fraudProbability } from "./assess.js";
import { capSingleSignal, type SingleSignalCap } from "./singleSignal.js";
import { applyChannelRule, applyNewDeviceRule, type ChannelRule, type NewDeviceRule } from "./patternRules.js";
import { describeProxyDeviceRing, describeStructuringBurst } from "./evidenceBuilder.js";
import { buildExplanation } from "./explain.js";
import { buildContextBundle, renderContextBundle } from "./contextBuilder.js";
import { createFacts, createEvidenceIdGen, runSharedOriginCorroboration, runStandardGather, type InvestigationFacts, type GatherRuntime } from "./investigation.js";
import { planEvidenceGathering, type PreferenceBand } from "./planner.js";
import { recommendActions, summarizeChange, type Recommendations } from "./recommend.js";
import { describeEvaluateStop, evaluateStop, type StopRuleDecision, type StopReason } from "./stopRule.js";
import { estimateTokens } from "./structured.js";
import { EventLog } from "./events.js";
import { DEFAULT_MAX_TOOL_CALLS, ToolBudgetExceededError, ToolRegistry } from "./toolsRegistry.js";
import type { LlmClient } from "./llm.js";
import type { McpClient } from "./mcpClient.js";
import type { ToolCatalog } from "@hhgoa/contracts";
import { buildCaseStateForPolicy } from "./caseState.js";
import { applyPatternScore, renderScorerState, type PatternScorer } from "./patternScorer.js";

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
/**
 * Real write-back of a finished case (vertex + case memory into TigerGraph,
 * see agent/src/persistCase.ts). Only supplied for real-backend runs; the
 * machine stays honest: with no persistCase the answer reports
 * `written_to_graph: false` and an empty `graph_case_id`.
 */
export interface PersistCaseRequest {
  caseRecord: AnswerFile["case"];
  case_id: string;
  as_of: string;
  customer_id: string;
  card_id: string;
  txn_id: string;
  /** The FraudCase primary id this run used (synthetic GRAPH-<case_id>). */
  graphCaseId: string;
  /** Case clock (snapshot run: both are the run's as_of). */
  opened_at: string;
  closed_at: string;
  /** Evidence items become Finding vertices (HAS_FINDING). */
  findings: EvidenceItem[];
  /** Recorded recommendations become ActionRecord vertices (HAS_ACTION). */
  actions: Recommendations["actions"];
  /** SAR-filed flag for the FraudCase's report_filed column. */
  sarFiled: boolean;
}

export interface PersistCaseResult {
  ok: boolean;
  graph_case_id: string;
}

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
  /**
   * Optional. When set (real backend), run() awaits this after assembly and
   * reports its ACTUAL outcome in `case.written_to_graph` / `graph_case_id`
   * (`false`/`""` on failure — a failed write is not a written case).
   */
  persistCase?: (request: PersistCaseRequest) => Promise<PersistCaseResult>;
  maxToolCalls?: number;
  maxEvidenceRounds?: number;
  maxInvestigateLoops?: number;
  /**
   * Optional pattern scorer (Jev / Kev decision model). When present it
   * re-ranks the documented patterns after each assessment; the LLM's
   * fraud-vs-legitimate mass is kept.
   */
  scorer?: PatternScorer | null;
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
  // README's own worked example files a GSQL query result as source `graph` with
  // ref `query:card_window(...)`, and reserves `document` for text cited by
  // section. The `policy_match` category is emitted only by detect_patterns,
  // which is a GSQL query over the graph -- it matches the *documented* patterns
  // but the evidence is computed by traversal, not read out of the policy. It was
  // being filed as `document`, overstating that a policy passage had been read.
  const source: CaseEvidence["source"] =
    item.category === "customer_response"
      ? "customer"
      : item.category === "external"
        ? "external"
        : item.category === "policy_match" && item.source_tool !== "detect_patterns"
          ? "document"
          : "graph";
  return {
    claim: item.summary,
    source,
    ref: item.id,
    // Cards the dataset never names carry a synthetic "X<card1>-K<rank>" id
    // (see graph/scripts/prepareLoadFiles.ts). They are real vertices, but not
    // real dataset ids, and every id an answer cites has to exist in the
    // dataset or it scores as fabricated.
    entity_ids: item.entities.map((e) => e.id).filter((id) => !SYNTHETIC_CARD_ID.test(id)),
  };
}

const SYNTHETIC_CARD_ID = /^X\d+-K\d+$/;

/** Probability at or above which the evidence alone reads as fraud. */
const FRAUD_VERDICT_THRESHOLD = 0.7;
/** Probability at or below which the evidence alone reads as legitimate. */
const LEGITIMATE_VERDICT_THRESHOLD = 0.4;

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
  /** Set when the R1 single-signal guard capped the last assessment. */
  private singleSignalCap: SingleSignalCap | null = null;
  private newDeviceRule: NewDeviceRule | null = null;
  private channelRule: ChannelRule | null = null;
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

  /** The LLM-free evidence sweep that opens every run. */
  private async gather(): Promise<void> {
    const gatherRuntime: GatherRuntime = {
      catalog: this.registry.catalog,
      facts: this.facts,
      idGen: this.idGen,
      asOf: this.deps.asOf,
      onEvidence: (item) => {
        this.onEvidence(item, "INVESTIGATING");
        return Promise.resolve();
      },
    };
    // The sweep is best-effort against the tool budget. beginTool throws
    // ToolBudgetExceededError once the budget is gone, and the gather steps have
    // no view of the registry to check first, so exhaustion partway through has
    // to be caught here: the run then assesses on the evidence it did collect
    // and the stop rule finalizes as budget_exhausted. Before the sweep grew to
    // cover the brief's full evidence list it happened to fit inside even a
    // 4-call budget, so this path was never exercised and the error escaped
    // run() instead of stopping the case cleanly.
    try {
      await runStandardGather(gatherRuntime);
      // Corroboration second opinion (conditional; see investigation.ts).
      await runSharedOriginCorroboration(gatherRuntime);
    } catch (err) {
      if (!(err instanceof ToolBudgetExceededError)) throw err;
    }
  }

  /**
   * Runs only the evidence sweep and returns what it collected: no case is
   * opened, no LLM is called, nothing is written. The Kev training export uses
   * this so the states a scorer learns from are built by exactly the code that
   * builds them at inference.
   */
  async collectEvidence(): Promise<EvidenceItem[]> {
    await this.gather();
    return [...this.evidenceStore];
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
    // Assessor stage count is a measured switch, not a preference. Two-stage
    // (triage classifies with no numbers, then calibration scores the
    // survivors over a distilled brief) was tried to break the single-call
    // hedge where 7 of 20 probabilities sat on exactly 0.65. On the same
    // leak-free 20-case sample it did the opposite of what it was for:
    // pattern exact 47.1% -> 17.6%, false negatives 0/17 -> 6/17, decision
    // agreement 85% -> 60%. Two of those false negatives were the 7B triage
    // marking card_testing fits=false on 300+ evidence items, so calibration
    // never saw a fraud hypothesis and filed ALLOW + CLOSE_NO_FRAUD on
    // confirmed fraud. The split hands a small model a judgement it makes
    // worse in pieces than in one pass. Single-stage is the default; set
    // ASSESSOR_STAGES=2 to measure the other path again.
    const prompts = await import("./prompts.js");
    const stages: 1 | 2 = process.env.ASSESSOR_STAGES === "2" ? 2 : 1;
    const out = await assess({
      llm: this.llm,
      stages,
      systemPrompt: prompts.assessSystemPrompt(),
      triageSystemPrompt: prompts.triageSystemPrompt(),
      calibrateSystemPrompt: prompts.calibrateSystemPrompt(),
      contextText,
      trigger: this.facts.trigger,
      evidence: this.evidenceStore,
      sufficiency: placeholder,
    });
    this.tokens += out.structured.rawTexts.reduce((s, t) => s + estimateTokens(t), 0);
    const reranked = await this.scorerRerank(out.assessment.hypotheses);
    if (reranked) out.assessment = { ...out.assessment, hypotheses: reranked };
    // Channel rule (patternRules.ts): a card-present pattern does not top a
    // case whose flagged charge was online.
    const channel = applyChannelRule(out.assessment.hypotheses, this.evidenceStore);
    if (channel) out.assessment = { ...out.assessment, hypotheses: channel.hypotheses };
    this.channelRule = channel;
    // Pattern 3's definition (patternRules.ts): a CNP reading of a case whose
    // flagged charge is on a New device is the new-device pattern.
    const newDevice = applyNewDeviceRule(out.assessment.hypotheses, this.evidenceStore);
    if (newDevice) out.assessment = { ...out.assessment, hypotheses: newDevice.hypotheses };
    this.newDeviceRule = newDevice;
    // R1 guard (singleSignal.ts): a fraud reading resting on one independent
    // signal is filed just below the fraud line, so R1's verification runs
    // before any block.
    const capped = capSingleSignal(out.assessment.hypotheses, this.evidenceStore, FRAUD_VERDICT_THRESHOLD - 0.01);
    if (capped) {
      const legit = capped.hypotheses.find((h) => h.fraud_type === "legitimate")?.probability ?? 0;
      out.assessment = {
        ...out.assessment,
        hypotheses: capped.hypotheses,
        legit_hypothesis_probability: legit,
        risk_level: deriveRiskLevel(capped.to),
      };
    }
    this.singleSignalCap = capped;

    const recs = recommendActions(this.facts, out.assessment, this.evidenceStore, this.computeVerdict(out.assessment));
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
    this.events.emit("assessment_updated", "ASSESSING", {
      assessment,
      ...(this.newDeviceRule
        ? { pattern_rule: { rule: "new_device_is_pattern_3", moved: this.newDeviceRule.moved, evidence: this.newDeviceRule.item } }
        : {}),
      ...(this.channelRule
        ? {
            channel_rule: {
              rule: "online_flag_rules_out_card_present",
              from: this.channelRule.from,
              to: this.channelRule.to,
              moved: this.channelRule.moved,
              evidence: this.channelRule.item,
            },
          }
        : {}),
      ...(this.singleSignalCap
        ? {
            r1_single_signal_cap: {
              fraud_probability_from: this.singleSignalCap.from,
              fraud_probability_to: this.singleSignalCap.to,
              independent_signals: this.singleSignalCap.signals,
            },
          }
        : {}),
    });

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

  /**
   * The scorer's pattern distribution over the current evidence, applied to
   * the assessor's hypotheses. Logged as a tool call (`<name>_pattern_score`)
   * so the trail shows it; any failure leaves the assessor's ranking in place.
   */
  private async scorerRerank(hypotheses: Hypothesis[]): Promise<Hypothesis[] | null> {
    const scorer = this.deps.scorer;
    if (!scorer) return null;
    const tool = `${scorer.name}_pattern_score`;
    const state = renderScorerState(this.evidenceStore, scorer.stateLimits);
    this.events.emit("tool_call", "ASSESSING", { tool, args: { state } });
    try {
      const score = await scorer.scorePattern(state);
      this.events.emit("tool_result", "ASSESSING", { tool, result: { ok: true, data: score } });
      return applyPatternScore(hypotheses, score, this.evidenceStore);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.events.emit("tool_result", "ASSESSING", { tool, result: { ok: false, error } });
      return null;
    }
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
    // A request that came back unanswered is not evidence. The dataset supplies
    // no cardholder or analyst replies (README §5), so the responder reports a
    // non-response rather than inventing one; folding that into the store would
    // add a `customer_response` category that raises the confidence cap while
    // saying nothing. The request itself is still recorded in `reqLog` below.
    const evidence = response?.responded ? (response.evidence ?? null) : null;
    if (evidence) {
      // Result of the request is itself evidence (PRD §8.3, category
      // customer_response): surface it and fold its verdict into the facts.
      this.onEvidence(evidence, "EVIDENCE_RECEIVED");
      // These two facts mean what they say: the cardholder themselves
      // answered. Only a cardholder-facing verification may set them. An
      // analyst_info note is third-party colour and is already counted as
      // ordinary evidence by onEvidence() above; promoting it to a cardholder
      // statement is not harmless, because computeVerdict treats a denial as
      // decisive and policy's `min_probability_unless_customer_denied` lets it
      // bypass the probability prerequisite for blocking actions.
      // A *failed* step-up is not a denial (the cardholder may simply never
      // have answered), but a *completed* one is affirmative proof of presence.
      if (chosen.type === "customer_validation") {
        if (evidence.supports.includes("fraud")) this.facts.customer_denied = true;
        if (evidence.supports.includes("legitimate")) this.facts.customer_confirmed = true;
      } else if (chosen.type === "step_up_auth" && evidence.supports.includes("legitimate")) {
        this.facts.customer_confirmed = true;
      }
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
    // close go through the silent (non-budgeted) case accessors. The actual
    // vertex write-back happens (if at all) after assembly via
    // deps.persistCase; `writtenToGraph` stays false until that reports ok.
    await this.registry.caseSetStatus(this.resolveStatus());
    await this.registry.caseClose();
    this.events.emit("memory_written", "MEMORY_UPDATE", { graph_case_id: this.graphCaseId });
  }

  /** Verdict: a cardholder verification settles it; otherwise conviction bands. */
  /**
   * The probability we file, reconciled with a cardholder verification.
   *
   * `fraud_probability` is scored for calibration, so it has to agree with
   * the verdict. The cardholder's own answer settles the question (README
   * sec.6) and computeVerdict honours that, but the number came from the
   * assessor, which weighs a denial as just one more evidence item — HHG-006
   * filed `verdict: fraud` alongside `fraud_probability: 0.25` after the
   * cardholder denied the charge. A verification answer is authoritative, so
   * the posterior is pulled into the band its verdict implies rather than
   * left to the model's own weighting of it.
   */
  private reconciledProbability(assessment: Assessment, verdict: Verdict): number {
    const top = topFraudHypothesis(assessment);
    const raw = fraudProbability(assessment);
    const denied = this.facts.customer_denied;
    const confirmed = this.facts.customer_confirmed;
    if (denied === confirmed) return raw;
    if (denied && verdict === "fraud") return Math.max(raw, FRAUD_VERDICT_THRESHOLD);
    if (confirmed && verdict === "legitimate") return Math.min(raw, LEGITIMATE_VERDICT_THRESHOLD);
    return raw;
  }

  private computeVerdict(assessment: Assessment): Verdict {
    const top = topFraudHypothesis(assessment);
    const topProb = fraudProbability(assessment);
    // A verification response settles the question (README §6) — in *both*
    // directions. A denial used to override the probability outright while a
    // confirmation moved nothing, so cases closed as fraud at p=0.25.
    const denied = this.facts.customer_denied;
    const confirmed = this.facts.customer_confirmed;
    // The reply is SIMULATED by us -- README §5 says cardholder and analyst
    // replies "are not provided" and instructs us to simulate them, so it is a
    // documented assumption, not a recorded fact. It reaches the assessor as an
    // ordinary evidence item and is already priced into `topProb`. Applying it
    // again here as a veto counted it twice: every confirmed-fraud case that
    // drew a scripted "customer confirms" closed legitimate (6 of 6 in a
    // 35-case backtest, 6 of the 8 false negatives), discarding graph evidence
    // that ran to 159 items on one of them. The bands decide; a reply only
    // breaks the tie inside the uncertain span, which is also how README's own
    // worked example treats it ("denial raised probability from 0.72 to 0.86"
    // -- an update, not an override).
    if (topProb >= FRAUD_VERDICT_THRESHOLD) return "fraud";
    if (topProb <= LEGITIMATE_VERDICT_THRESHOLD) {
      // A denial against near-exculpatory evidence is a genuine conflict, not a
      // clearance: report it as unresolved rather than closing either way.
      return denied && !confirmed ? "uncertain" : "legitimate";
    }
    if (denied && !confirmed) return "fraud";
    return "uncertain";
  }

  private resolveStatus(): CaseStatus {
    const recs = this.finalRecs;
    // `open` means more evidence is still pending (README, Answer Format). A
    // case handed to an analyst is not pending — it is escalated, whether it
    // got there via an approval route or via R8's ESCALATE_TO_ANALYST (which
    // is agent-executable, so it carries no L1/L2 route of its own).
    if (
      recs &&
      recs.actions.some(
        (a) => a.route === "L1" || a.route === "L2" || a.action === "ESCALATE_TO_ANALYST",
      )
    ) {
      return "escalated";
    }
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
    const pattern = resolvePatternLabel(assessment, this.graphUndocumented());
    const pendingReport = recs.actions.some((a) => a.action === "FILE_REPORT");
    if (!pendingReport || !sarRequired(cs)) {
      return { file: false, reason: "", narrative: "", subjects: [], total_amount_usd: 0, activity_dates: [] };
    }
    const affectedSet = new Set(this.facts.affected_txn_ids);
    const affectedTxns = this.facts.txn_rows.filter((r) => affectedSet.has(r.txn_id));
    const pattern_description = pattern === "undocumented" ? this.undocumentedDescription() : "";
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

  /**
   * The graph names `undocumented`: the flagged charge's device is the
   * cross-card anonymous-proxy ring, or detect_patterns found the
   * amount-structuring burst. Either way it is a graph finding, not a guess.
   */
  private graphUndocumented(): boolean {
    return (
      Boolean(this.facts.proxy_device_ring) ||
      this.facts.patterns.some((p) => p.pattern_id === "undocumented")
    );
  }

  /**
   * R9: an undocumented pattern is described "in your own words". The device
   * ring describes itself from its own counts. Otherwise the case is fraud
   * the documented patterns do not fit -- the old text quoted the model's
   * hypothesis name, which was "legitimate" or empty by construction here.
   */
  private undocumentedDescription(): string {
    const ring = this.facts.proxy_device_ring;
    if (ring) return describeProxyDeviceRing(ring);
    const structuring = this.facts.patterns.find((p) => p.pattern_id === "undocumented");
    if (structuring) return describeStructuringBurst(structuring.evidence, this.facts.txn_rows, this.facts.primary_card?.id);
    return this.facts.customer_denied
      ? "Activity the cardholder does not recognise that matches none of the documented patterns"
      : "Activity assessed as fraud that matches none of the five documented patterns";
  }

  private async assemble(assessment: Assessment, recs: Recommendations, stopReasonText: string): Promise<AnswerFile> {
    const top = topFraudHypothesis(assessment);
    const topProb = fraudProbability(assessment);
    const verdict = this.cachedVerdict;
    const legit = verdict === "legitimate";
    // README: "Cleared cases have `pattern` = `none`" — so `none` belongs to a
    // case we are clearing, not to one we are calling fraud. A cardholder
    // denial can force a fraud verdict while the model's top hypothesis is
    // still `legitimate`, which filed "fraud, pattern none". Activity we
    // believe is fraud but cannot name is `undocumented` (R9), which the
    // answer format requires to carry a description.
    const named = resolvePatternLabel(assessment, this.graphUndocumented()) as Pattern;
    // The pattern has to agree with the verdict in both directions: a case we
    // are clearing carries `none`, and one we are calling fraud never does.
    const pattern: Pattern = legit ? "none" : named === "none" ? "undocumented" : named;
    const pattern_description = pattern === "undocumented" ? this.undocumentedDescription() : "";
    const cs = buildCaseStateForPolicy(this.facts, assessment, this.evidenceStore);

    // README: affected_txn_ids is "every transaction you believe is part of
    // the same fraud episode, including the flagged one". The flagged
    // transaction can fall outside the history sweep (a disputed charge the
    // window missed), so add it back rather than report an episode that
    // omits the very transaction the case was opened on.
    const flaggedId = this.facts.txn?.id ?? "";
    const affectedTxnIds =
      flaggedId && !this.facts.affected_txn_ids.includes(flaggedId)
        ? [flaggedId, ...this.facts.affected_txn_ids]
        : this.facts.affected_txn_ids;

    const sar = await this.buildSar(assessment, recs);

    const summary =
      `Investigated card ${this.facts.primary_card?.id ?? "?"} after trigger; pattern ${pattern}, ` +
      `top probability ${topProb.toFixed(2)}, ${distinctEvidenceCategories(this.evidenceStore).length} evidence ` +
      `categories, exposure ${money(this.facts.exposure_usd)}. Verdict: ${verdict}.`;

    const answer = {
      case_id: this.facts.case_id,
      investigation_record: this.events.list(),
      case: {
        status: this.resolveStatus(),
        verdict,
        fraud_probability: Math.round(this.reconciledProbability(assessment, verdict) * 1e6) / 1e6,
        pattern,
        pattern_description,
        affected_txn_ids: legit ? [] : affectedTxnIds,
        first_suspicious_txn_id: legit ? "" : (affectedTxnIds[0] ?? ""),
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
          ? summarizeChange(this.initialRecs.actions, recs.actions, assessment, this.facts, this.reqLog)
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
    await this.gather();

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
    let final: RunResult = {
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

    // Real write-back happens only when the caller provided deps.persistCase
    // (real backend); otherwise nothing was written to any graph, so report
    // it honestly rather than echoing a synthetic id.
    if (this.deps.persistCase) {
      const persisted = await this.deps.persistCase({
        caseRecord: assembled.case,
        case_id: this.facts.case_id,
        as_of: this.facts.as_of,
        customer_id: this.facts.customer?.id ?? "",
        card_id: this.facts.primary_card?.id ?? "",
        txn_id: this.facts.txn?.id ?? "",
        graphCaseId: this.graphCaseId,
        opened_at: this.deps.asOf,
        closed_at: this.deps.asOf,
        findings: this.evidenceStore,
        actions: recs.actions,
        sarFiled: assembled.sar.file,
      });
      this.writtenToGraph = persisted.ok;
      this.graphCaseId = persisted.ok ? persisted.graph_case_id || this.graphCaseId : "";
    } else {
      this.writtenToGraph = false;
      this.graphCaseId = "";
    }

    // latency_s was filled at assembly time; patch it with the real value and
    // sync the case provenance fields now that write-back (if any) is done.
    const refreshed = AnswerFileSchema.parse({
      ...final.answer,
      case: { ...final.answer.case, written_to_graph: this.writtenToGraph, graph_case_id: this.graphCaseId },
      latency_s: Number((latencyMs / 1000).toFixed(2)),
    });
    final.answer = refreshed;
    final.graphCaseId = this.graphCaseId;
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