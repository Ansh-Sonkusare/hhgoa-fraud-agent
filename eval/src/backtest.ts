import { mkdirSync, writeFileSync } from "node:fs";
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

/** Replays a closed case as a risk-score-style trigger (PRD §9.1 adapters). */
export function targetFromClosedCase(c: ClosedCase, index: number): { trigger: Trigger; highestRiskTxn?: string } {
  const txn = c.first_fraud_txn_id || c.txn_ids[0] || "";
  return {
    trigger: {
      kind: "risk_score",
      txn_id: txn || undefined,
      card_id: c.card_id || undefined,
      risk_score: 0.5,
    },
    highestRiskTxn: txn,
  };
}

/** Runs the backtest batch and returns scored runs + metrics. */
export async function runBacktestSample(sample: ClosedCase[], opts: { noCache?: boolean } = {}): Promise<{ runs: ScoredRun[]; caseRuns: CaseRun[]; labelMap: Map<string, ClosedCase> }> {
  const labelMap = new Map(sample.map((c) => [c.case_id, c]));
  const caseRuns: CaseRun[] = [];
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i]!;
    const { trigger } = targetFromClosedCase(c, i);
    process.stdout.write(`[${i + 1}/${sample.length}] backtest ${c.case_id} (${c.outcome}) as_of=${c.opened_at}\n`);
    const run = await runOneTarget({ caseId: c.case_id, asOf: c.opened_at, trigger }, opts);
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
}

export async function backtest(opts: { sample?: number; seed?: number; holdOut?: number; noCache?: boolean }): Promise<BacktestResult> {
  loadEnv();
  const cases = loadClosedCases();
  const seed = opts.seed ?? Number(env("BACKTEST_SEED", "42"));
  const holdOut = opts.holdOut ?? Number(env("BACKTEST_HOLDOUT", "0.3"));
  const { train, holdout } = splitClosedCases(cases, holdOut, seed);
  const sample = sampleHoldout(holdout, opts.sample ?? Number(env("BACKTEST_SAMPLE", "10")), seed + 1);

  const mode = runModeFromEnv();
  const problems = await preflight(mode);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`preflight: ${p}\n`);
  }

  const { runs } = await runBacktestSample(sample, { noCache: opts.noCache });

  const costPer1k = Number(env("COST_PER_1K_TOKENS", "0"));
  const metrics = computeMetrics(runs, costPer1k);
  return { sampleSize: sample.length, holdoutSize: holdout.length, trainSize: train.length, metrics, runs };
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
  const notes = path.join(repoRoot(), "eval", "NOTES.md");
  mkdirSync(path.dirname(notes), { recursive: true });
  const table = renderMetricsTable(result.metrics);
  const block = `## Backtest (${new Date().toISOString()})

Holdout ${result.holdoutSize} of ${result.holdoutSize + result.trainSize} closed cases (stratified); sampled ${result.sampleSize} for this runnable batch.

${table}`;
  writeFileSync(notes, block + "\n", "utf8");
  process.stdout.write(`${table}\n\nbacktest result written to ${path.relative(repoRoot(), notes)}\n`);
  return result.metrics.n === 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("backtest.ts")) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`backtest failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}