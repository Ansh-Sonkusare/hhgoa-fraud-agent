import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Trigger } from "@hhgoa/contracts";
import { loadClosedCases, type ClosedCase } from "./dataset.js";
import { runOneTarget, type CaseRun, runModeFromEnv, preflight } from "./runner.js";
import { computeMetrics, renderMetricsTable, scoreRun, type ScoredRun } from "./metrics.js";
import { loadEnv, env, repoRoot } from "./env.js";

/** Deterministic PRNG (mulberry32) so splits are reproducible across runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SplitResult {
  train: ClosedCase[];
  holdout: ClosedCase[];
}

/**
 * Stratified hold-out split (PRD §15): groups by (outcome, pattern) and
 * takes `holdOut` of each group into the holdout set, deterministically.
 * The remainder is the "memory" population the backtest conceptually loads.
 */
export function splitClosedCases(cases: ClosedCase[], holdOut = 0.3, seed = 42): SplitResult {
  const rng = mulberry32(seed);
  const groups = new Map<string, ClosedCase[]>();
  for (const c of cases) {
    const key = `${c.outcome}|${c.pattern}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  const train: ClosedCase[] = [];
  const holdout: ClosedCase[] = [];
  for (const list of groups.values()) {
    // Fisher–Yates inside the group.
    const arr = [...list];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i]!, arr[j]!] = [arr[j]!, arr[i]!];
    }
    const nHold = Math.max(1, Math.min(arr.length, Math.round(arr.length * holdOut)));
    holdout.push(...arr.slice(0, nHold));
    train.push(...arr.slice(nHold));
  }
  return { train, holdout };
}

/** Deterministic, strata-spread sample of the holdout for a runnable backtest batch. */
export function sampleHoldout(holdout: ClosedCase[], n: number, seed = 7): ClosedCase[] {
  if (n <= 0 || holdout.length === 0) return [];
  const byStrata = new Map<string, ClosedCase[]>();
  for (const c of holdout) {
    const key = `${c.outcome}|${c.pattern}`;
    const list = byStrata.get(key);
    if (list) list.push(c);
    else byStrata.set(key, [c]);
  }
  const rng = mulberry32(seed);
  const out: ClosedCase[] = [];
  const pools = [...byStrata.entries()].map(([k, v]) => ({ k, v: [...v] }));
  while (out.length < n && pools.length > 0) {
    for (let i = pools.length - 1; i >= 0; i--) {
      const pool = pools[i]!;
      const idx = Math.floor(rng() * pool.v.length);
      out.push(pool.v[idx]!);
      pool.v.splice(idx, 1);
      if (pool.v.length === 0) pools.splice(i, 1);
      if (out.length >= n) break;
    }
  }
  return out;
}

const ALERT_OPENING = /^Case \S+: model scored a \$[\d,]+\.\d\d transaction at (\d\.\d+)/;
// Two phrasings: "reported unrecognized activity" (4,656 cases) and
// "reported 3 online purchase(s) they did not make" (the 9 undocumented ones).
const REPORT_OPENING = /^Case \S+: cardholder C\d+ reported\b/;

/**
 * Replays a closed case the way it actually opened (PRD §9.1 adapters).
 *
 * closed_cases_history has no trigger column, but every analyst note opens by
 * saying how the case began -- "model scored a $442.92 transaction at 0.91" or
 * "cardholder C00259 reported unrecognized activity". Only that opening clause
 * is read; the rest of the note states the outcome and never reaches the agent.
 * The score parsed from a model-scored note equals the flagged transaction's own
 * risk_score and amount on all 900 such cases.
 *
 * This used to replay every case as a risk-score alert scored 0.5, a value the
 * dataset never contains: disputes arrived without the cardholder's denial and
 * alerts without their real score. Know what the faithful replay implies. In
 * this history origin is perfectly confounded with outcome -- all 4,665
 * disputes were confirmed fraud and all 900 model alerts were cleared -- so R2
 * settles the verdict on every replayed dispute by itself. Read the backtest's
 * pattern accuracy and its handling of cleared alerts, not verdict agreement,
 * as the measure of the investigation. The case it cannot exercise at all is a
 * model alert that turns out to be fraud: the history has none, while 11 of the
 * 20 benchmark cases are model alerts scored 0.52-0.90.
 */
export function targetFromClosedCase(c: ClosedCase, _index: number): { trigger: Trigger; highestRiskTxn?: string } {
  const txn = c.first_fraud_txn_id || c.txn_ids[0] || "";
  if (REPORT_OPENING.test(c.analyst_notes)) {
    return {
      trigger: {
        kind: "customer_report",
        customer_id: c.customer_id,
        txn_ids: txn ? [txn] : undefined,
        text: `Customer ${c.customer_id} reported unrecognized activity on card ${c.card_id}.${txn ? ` Refers to ${txn}.` : ""}`,
      },
      highestRiskTxn: txn,
    };
  }
  const alert = ALERT_OPENING.exec(c.analyst_notes);
  if (alert) {
    return {
      trigger: { kind: "risk_score", txn_id: txn || undefined, card_id: c.card_id || undefined, risk_score: Number(alert[1]) },
      highestRiskTxn: txn,
    };
  }
  throw new Error(`backtest: ${c.case_id}'s analyst note does not say how the case opened`);
}

/** Runs the backtest batch and returns scored runs + metrics. */
export async function runBacktestSample(sample: ClosedCase[], opts: { noCache?: boolean } = {}): Promise<{ runs: ScoredRun[]; caseRuns: CaseRun[]; labelMap: Map<string, ClosedCase> }> {
  const labelMap = new Map(sample.map((c) => [c.case_id, c]));
  const caseRuns: CaseRun[] = [];
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i]!;
    const { trigger } = targetFromClosedCase(c, i);
    process.stdout.write(`[${i + 1}/${sample.length}] backtest ${c.case_id} (${c.outcome}) as_of=${c.opened_at}\n`);
    // Never persist during a backtest: the closed cases we score against live
    // in the same graph, so writing synthetic records mid-sample lets later
    // cases read earlier ones back as real prior cases.
    // A case that errors (LLM or graph unavailable after the client's own
    // retries, a case timeout) is run again after a pause instead of being
    // scored as a failure: BACKTEST_CASE_RETRIES more attempts (default 2).
    const retries = Number(env("BACKTEST_CASE_RETRIES", "2"));
    let run = await runOneTarget({ caseId: c.case_id, asOf: c.opened_at, trigger }, { ...opts, writeBackCase: false });
    for (let attempt = 1; run.error && attempt <= retries; attempt++) {
      process.stdout.write(`  error: ${run.error} -- retrying (${attempt}/${retries}) in 30s\n`);
      await new Promise((r) => setTimeout(r, 30_000));
      run = await runOneTarget({ caseId: c.case_id, asOf: c.opened_at, trigger }, { ...opts, noCache: true, writeBackCase: false });
    }
    caseRuns.push(run);
    if (run.error) process.stdout.write(`  error: ${run.error}\n`);
    else process.stdout.write(`  verdict=${run.answer?.case.verdict} pattern=${run.answer?.case.pattern} (${(run.latencyMs / 1000).toFixed(1)}s)\n`);
  }
  const runs: ScoredRun[] = caseRuns.map((r) =>
    scoreRun(r.case_id, labelMap.get(r.case_id)!, r.answer, r.toolCalls, r.tokens, r.latencyMs),
  );
  return { runs, caseRuns, labelMap };
}

export interface BacktestResult {
  sampleSize: number;
  holdoutSize: number;
  trainSize: number;
  metrics: ReturnType<typeof computeMetrics>;
  runs: ScoredRun[];
  caseRuns: CaseRun[];
  labelMap: Map<string, ClosedCase>;
}

export async function backtest(opts: { sample?: number; seed?: number; holdOut?: number; noCache?: boolean }): Promise<BacktestResult> {
  loadEnv();
  const cases = loadClosedCases();
  const seed = opts.seed ?? Number(env("BACKTEST_SEED", "42"));
  const holdOut = opts.holdOut ?? Number(env("BACKTEST_HOLDOUT", "0.3"));
  const { train, holdout } = splitClosedCases(cases, holdOut, seed);
  // BACKTEST_FROM keeps only cases opened at or after a date. A trained scorer
  // (Kev, see agent/src/kev.ts) learned from cases closed before its cutoff, so
  // its backtest must draw from after that cutoff or it is scored on cases
  // whose outcomes it was trained with.
  const from = env("BACKTEST_FROM", "");
  // BACKTEST_EXCLUDE names a file of case ids (one per line) to leave out of
  // the pool: cases already used to design or measure a change, so a fresh
  // sample tests the change on cases it was not shaped by.
  const excludePath = env("BACKTEST_EXCLUDE", "");
  const exclude = excludePath
    ? new Set(readFileSync(excludePath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
    : new Set<string>();
  const pool = holdout.filter((c) => (!from || c.opened_at >= from) && !exclude.has(c.case_id));
  const drawn = sampleHoldout(pool, opts.sample ?? Number(env("BACKTEST_SAMPLE", "10")), seed + 1);
  // BACKTEST_SHARD="i/n" runs every n-th case of the drawn sample starting at
  // i, so n processes can split one sample between them (the graph and scorer
  // calls of one overlap the other's LLM call). Merge their detail files after.
  const shard = /^(\d+)\/(\d+)$/.exec(env("BACKTEST_SHARD", ""));
  const sample = shard ? drawn.filter((_, i) => i % Number(shard[2]) === Number(shard[1])) : drawn;

  const mode = runModeFromEnv();
  const problems = await preflight(mode);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`preflight: ${p}\n`);
  }

  const { runs, caseRuns, labelMap } = await runBacktestSample(sample, { noCache: opts.noCache });

  const costPer1k = Number(env("COST_PER_1K_TOKENS", "0"));
  const metrics = computeMetrics(runs, costPer1k);
  return { sampleSize: sample.length, holdoutSize: holdout.length, trainSize: train.length, metrics, runs, caseRuns, labelMap };
}

async function main(): Promise<number> {
  loadEnv();
  const args = process.argv.slice(2);
  const flag = (name: string, base: number | null): number | null => {
    const i = args.indexOf(name);
    return i === -1 ? base : Number(args[i + 1]);
  };
  const sample = flag("--sample", null);
  const seed = flag("--seed", null);
  const holdOut = flag("--holdout", null);
  const noCache = args.includes("--no-cache");

  const result = await backtest({ sample: sample ?? undefined, seed: seed ?? undefined, holdOut: holdOut ?? undefined, noCache });
  // BACKTEST_OUT_TAG keeps parallel shards from overwriting each other's files.
  const tag = env("BACKTEST_OUT_TAG", "");
  const notes = path.join(repoRoot(), "eval", tag ? `NOTES.${tag}.md` : "NOTES.md");
  mkdirSync(path.dirname(notes), { recursive: true });
  const table = renderMetricsTable(result.metrics);
  const block = `## Backtest (${new Date().toISOString()})

Holdout ${result.holdoutSize} of ${result.holdoutSize + result.trainSize} closed cases (stratified); sampled ${result.sampleSize} for this runnable batch.

${table}`;
  writeFileSync(notes, block + "\n", "utf8");

  // Per-case detail: the metrics table says accuracy is low, only this says
  // WHICH pattern gets mistaken for which, and on what evidence.
  const detail = result.caseRuns.map((r) => {
    const gold = result.labelMap.get(r.case_id);
    const c = r.answer?.case;
    const byCat: Record<string, number> = {};
    for (const e of c?.evidence ?? []) byCat[e.source] = (byCat[e.source] ?? 0) + 1;
    return {
      case_id: r.case_id,
      gold_outcome: gold?.outcome ?? null,
      gold_pattern: gold?.pattern ?? null,
      predicted_verdict: c?.verdict ?? null,
      predicted_pattern: c?.pattern ?? null,
      fraud_probability: c?.fraud_probability ?? null,
      status: c?.status ?? null,
      affected_txns: c?.affected_txn_ids?.length ?? 0,
      exposure_usd: c?.exposure_usd ?? 0,
      evidence_total: c?.evidence?.length ?? 0,
      evidence_by_source: byCat,
      actions: (r.answer?.next_best_actions?.final ?? []).map((a: { action: string }) => a.action),
      error: r.error,
    };
  });
  const detailPath = path.join(repoRoot(), "eval", tag ? `backtest-detail.${tag}.json` : "backtest-detail.json");
  writeFileSync(detailPath, JSON.stringify(detail, null, 2), "utf8");
  process.stdout.write(`${table}\n\nbacktest result written to ${path.relative(repoRoot(), notes)}\n`);
  return result.metrics.n === 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("backtest.ts")) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`backtest failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}