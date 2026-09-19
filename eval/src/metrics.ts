import type { AnswerFile } from "@hhgoa/contracts";
import type { ClosedOutcome, ClosedCase } from "./dataset.js";

/** Ground-truth label for one scored run (from backtest holdout). */
export interface GoldLabel {
  case_id: string;
  outcome: ClosedOutcome;
  pattern: string;
}

export interface ScoredRun {
  case_id: string;
  gold: GoldLabel;
  answer: AnswerFile | null;
  toolCalls: number;
  tokens: number;
  latencyMs: number;
}

/** Agent's operational decision: block/escalate (L1/L2 or fraud verdict) vs allow/monitor. */
export function agentEscalates(answer: AnswerFile): boolean {
  if (answer.case.verdict === "fraud") return true;
  if (answer.case.status === "escalated") return true;
  return answer.next_best_actions.final.some((a) => a.route === "L1" || a.route === "L2");
}

export interface EvidenceEval {
  /** final action set differs from initial (decision-changing evidence). */
  changed: boolean;
}

/** Evidence-request usefulness signal per answer (PRD §15). */
export function evidenceEval(answer: AnswerFile): EvidenceEval {
  const changed = JSON.stringify(answer.next_best_actions.final) !== JSON.stringify(answer.next_best_actions.initial);
  return { changed };
}

function classScores(predicted: (string | null)[], gold: string[]): { precision: number; recall: number; f1: number } {
  const goldSet = new Set(gold);
  const allClasses = [...new Set<string>([...goldSet, ...new Set(predicted.filter((p): p is string => p !== null))])];
  if (allClasses.length === 0) return { precision: 0, recall: 1, f1: 0 };
  let f1Sum = 0;
  let precisionSum = 0;
  let recallSum = 0;
  for (const cls of allClasses) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (let i = 0; i < gold.length; i++) {
      const isPos = gold[i] === cls;
      const wasPred = predicted[i] === cls;
      if (isPos && wasPred) tp++;
      else if (!isPos && wasPred) fp++;
      else if (isPos && !wasPred) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    precisionSum += precision;
    recallSum += recall;
    f1Sum += precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  }
  const n = allClasses.length;
  return {
    precision: n === 0 ? 0 : precisionSum / n,
    recall: n === 0 ? 0 : recallSum / n,
    f1: n === 0 ? 0 : f1Sum / n,
  };
}

export interface Metrics {
  n: number;
  patternF1: { macro: number; precision: number; recall: number; classes: number };
  patternAccuracy: number;
  decisionAgreement: number;
  falseBlockRate: number;
  evidenceRequestUsefulness: number;
  avgToolCalls: number;
  avgLatencyS: number;
  totalTokens: number;
  costUsd: number;
}

/** Computes the PRD §15 backtest metrics table from scored runs. */
export function computeMetrics(runs: ScoredRun[], costPer1kTokens = 0): Metrics {
  const n = runs.length;

  const fraudRuns = runs.filter((r) => r.gold.outcome === "confirmed_fraud" && r.gold.pattern !== "" && r.answer);
  const predictedPatterns: (string | null)[] = fraudRuns.map((r) => r.answer?.case.pattern ?? null);
  const goldPatterns = fraudRuns.map((r) => r.gold.pattern);
  const patternScores = classScores(predictedPatterns, goldPatterns);
  const patternAccuracy =
    fraudRuns.length === 0 ? 0 : fraudRuns.filter((r) => (r.answer?.case.pattern ?? null) === r.gold.pattern).length / fraudRuns.length;

  const labeled = runs.filter((r) => r.answer);
  const agreement =
    labeled.length === 0
      ? 0
      : labeled.filter((r) => {
          const esc = agentEscalates(r.answer!);
          return (r.gold.outcome === "confirmed_fraud" && esc) || (r.gold.outcome === "cleared" && !esc);
        }).length / labeled.length;

  const cleared = labeled.filter((r) => r.gold.outcome === "cleared");
  const falseBlockRate = cleared.length === 0 ? 0 : cleared.filter((r) => agentEscalates(r.answer!)).length / cleared.length;

  const withRequests = labeled.filter((r) => r.answer!.evidence_requests.length > 0);
  const evidenceRequestUsefulness =
    withRequests.length === 0
      ? 0
      : withRequests.filter((r) => evidenceEval(r.answer!).changed).length / withRequests.length;

  const totalTokens = runs.reduce((s, r) => s + r.tokens, 0);
  const avgToolCalls = n === 0 ? 0 : runs.reduce((s, r) => s + r.toolCalls, 0) / n;
  const avgLatencyS = n === 0 ? 0 : (runs.reduce((s, r) => s + r.latencyMs, 0) / n / 1000);
  const costUsd = (totalTokens / 1000) * costPer1kTokens;

  return {
    n,
    patternF1: { macro: patternScores.f1, precision: patternScores.precision, recall: patternScores.recall, classes: fraudRuns.length },
    patternAccuracy,
    decisionAgreement: agreement,
    falseBlockRate,
    evidenceRequestUsefulness,
    avgToolCalls,
    avgLatencyS,
    totalTokens,
    costUsd,
  };
}

/** Renders the metrics block used in eval/NOTES.md and the submission blog. */
export function renderMetricsTable(m: Metrics): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return [
    `| metric | value |`,
    `|---|---|`,
    `| cases scored | ${m.n} |`,
    `| fraud-type macro F1 | ${m.patternF1.macro.toFixed(3)} (precision ${m.patternF1.precision.toFixed(2)}, recall ${m.patternF1.recall.toFixed(2)}) |`,
    `| pattern accuracy (confirmed) | ${pct(m.patternAccuracy)} |`,
    `| decision agreement | ${pct(m.decisionAgreement)} |`,
    `| false-block rate (cleared) | ${pct(m.falseBlockRate)} |`,
    `| evidence-request usefulness | ${pct(m.evidenceRequestUsefulness)} |`,
    `| avg tool calls | ${m.avgToolCalls.toFixed(1)} |`,
    `| avg latency | ${m.avgLatencyS.toFixed(1)}s |`,
    `| tokens | ${m.totalTokens.toLocaleString()} |`,
    `| est. cost | $${m.costUsd.toFixed(2)} |`,
  ].join("\n");
}

/** Builds a ScoredRun from a raw gold label + answer (no run object needed). */
export function scoreRun(caseId: string, gold: Pick<ClosedCase, "outcome" | "pattern">, answer: AnswerFile | null, toolCalls = 0, tokens = 0, latencyMs = 0): ScoredRun {
  return { case_id: caseId, gold: { case_id: caseId, outcome: gold.outcome, pattern: gold.pattern }, answer, toolCalls, tokens, latencyMs };
}