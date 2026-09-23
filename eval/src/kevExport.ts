/**
 * Kev training / evaluation export.
 *
 * Replays closed cases through the agent's evidence sweep (no LLM, nothing
 * written) and writes one Kev request per case, labelled with the analyst's
 * pattern: `{state, questions: {pattern: {..., label}}, _meta}` — the JSONL
 * shape `python -m kev.train --data` reads.
 *
 * The split is by time, not by the backtest's stratified holdout. A trained
 * scorer carries every case it learned from; under the stratified split it
 * would learn from cases closed after the as_of of cases it is then scored on,
 * which PRD §8.1 forbids. Here:
 *   train: confirmed fraud with closed_at  <  cutoff (labels known by then)
 *   eval:  confirmed fraud with opened_at >= cutoff
 * and the end-to-end backtest is drawn with BACKTEST_FROM = cutoff.
 *
 *   tsx src/kevExport.ts --split train --cutoff "2016-09-01 00:00:00" --per-class 220 --out ../.cache/kev/train.jsonl
 *
 * Appends and skips case_ids already in --out, so an interrupted run resumes.
 * The raw evidence goes to `<out>.evidence.jsonl` alongside; `--rerender`
 * rebuilds --out from it, so a change to renderScorerState needs no new gather.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { EvidenceItem } from "@hhgoa/contracts";
import path from "node:path";
import { loadClosedCases, type ClosedCase } from "./dataset.js";
import { mulberry32, targetFromClosedCase } from "./backtest.js";
import { loadEnv } from "./env.js";

interface Args {
  split: "train" | "eval";
  cutoff: string;
  perClass: number;
  out: string;
  concurrency: number;
  seed: number;
  rerender: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const split = get("--split");
  if (split !== "train" && split !== "eval") throw new Error("--split train|eval is required");
  const out = get("--out");
  if (!out) throw new Error("--out is required");
  return {
    split,
    cutoff: get("--cutoff") ?? "2016-09-01 00:00:00",
    perClass: Number(get("--per-class") ?? "220"),
    out: path.resolve(out),
    concurrency: Number(get("--concurrency") ?? "2"),
    seed: Number(get("--seed") ?? "42"),
    rerender: argv.includes("--rerender"),
  };
}

/** Deterministic per-pattern sample of the eligible cases, capped at perClass. */
export function selectKevCases(
  cases: readonly ClosedCase[],
  split: "train" | "eval",
  cutoff: string,
  perClass: number,
  patterns: readonly string[],
  seed: number,
): ClosedCase[] {
  const eligible = cases.filter(
    (c) =>
      c.outcome === "confirmed_fraud" &&
      patterns.includes(c.pattern) &&
      (split === "train" ? c.closed_at !== "" && c.closed_at < cutoff : c.opened_at >= cutoff),
  );
  const rng = mulberry32(seed);
  const out: ClosedCase[] = [];
  for (const p of patterns) {
    const group = eligible.filter((c) => c.pattern === p).sort((a, b) => a.case_id.localeCompare(b.case_id));
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [group[i]!, group[j]!] = [group[j]!, group[i]!];
    }
    out.push(...group.slice(0, perClass));
  }
  return out;
}

async function main(): Promise<number> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const { createEvidenceCollector, renderScorerState, SCORER_PATTERNS, PATTERN_QUESTION } = await import("@hhgoa/agent");

  const evidenceFile = `${args.out}.evidence.jsonl`;
  const toRecord = (c: Pick<ClosedCase, "case_id" | "pattern" | "opened_at" | "closed_at">, evidence: EvidenceItem[]) => ({
    state: renderScorerState(evidence),
    questions: { pattern: { ...PATTERN_QUESTION, label: c.pattern } },
    _meta: { case_id: c.case_id, pattern: c.pattern, opened_at: c.opened_at, closed_at: c.closed_at, n_evidence: evidence.length },
  });
  if (args.rerender) {
    const lines = readFileSync(evidenceFile, "utf8").split("\n").filter((l) => l.trim());
    const records = lines.map((l) => {
      const row = JSON.parse(l) as Pick<ClosedCase, "case_id" | "pattern" | "opened_at" | "closed_at"> & { evidence: EvidenceItem[] };
      return JSON.stringify(toRecord(row, row.evidence));
    });
    writeFileSync(args.out, `${records.join("\n")}\n`);
    process.stdout.write(`kev-export: re-rendered ${records.length} states into ${args.out}\n`);
    return 0;
  }

  const selected = selectKevCases(loadClosedCases(), args.split, args.cutoff, args.perClass, SCORER_PATTERNS, args.seed);
  mkdirSync(path.dirname(args.out), { recursive: true });
  const done = new Set<string>();
  if (existsSync(args.out)) {
    for (const line of readFileSync(args.out, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const meta = (JSON.parse(line) as { _meta?: { case_id?: string } })._meta;
      if (meta?.case_id) done.add(meta.case_id);
    }
  }
  const todo = selected.filter((c) => !done.has(c.case_id));
  process.stdout.write(`kev-export ${args.split}: ${selected.length} selected, ${done.size} already written, ${todo.length} to go\n`);

  let next = 0;
  let written = 0;
  let failed = 0;
  const started = Date.now();
  const worker = async (): Promise<void> => {
    // One collector (MCP connection + RAG runtime) per worker.
    const collector = await createEvidenceCollector();
    try {
      while (next < todo.length) {
        const c = todo[next++]!;
        const t0 = Date.now();
        try {
          const { trigger } = targetFromClosedCase(c, 0);
          const evidence = await collector.collect({ caseId: c.case_id, asOf: c.opened_at, trigger });
          // Without the card's history there is nothing to learn from; the same
          // guard keeps graph-starved runs out of the backtest (runner.ts).
          if (!evidence.some((e) => e.source_tool === "get_transaction_history")) {
            throw new Error("no transaction history evidence (graph read failed?)");
          }
          appendFileSync(
            evidenceFile,
            `${JSON.stringify({ case_id: c.case_id, pattern: c.pattern, opened_at: c.opened_at, closed_at: c.closed_at, evidence })}\n`,
          );
          appendFileSync(args.out, `${JSON.stringify(toRecord(c, evidence))}\n`);
          written++;
          process.stdout.write(`[${written + failed}/${todo.length}] ${c.case_id} ${c.pattern} ${evidence.length} items ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
        } catch (err) {
          failed++;
          process.stdout.write(`[${written + failed}/${todo.length}] ${c.case_id} FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    } finally {
      await collector.close();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));
  process.stdout.write(`kev-export done: ${written} written, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  return failed > 0 && written === 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("kevExport.ts")) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`kev-export failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
