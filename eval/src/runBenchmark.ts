import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCasePack } from "./dataset.js";
import { runOne, preflight, runModeFromEnv, type CaseRun, type RunMode } from "./runner.js";
import { writeAnswersDir } from "./exportAnswers.js";
import { loadEnv, env, repoRoot } from "./env.js";

const DEFAULT_CASES_DIR = path.join(repoRoot(), "cases");
const DEFAULT_RUNS_DIR = path.join(repoRoot(), "runs");

function runId(): string {
  if (env("RUN_ID", "")) return env("RUN_ID", "");
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseFlags(argv: string[]): {
  caseId: string | null;
  noCache: boolean;
  planOnly: boolean;
  backend: "fake" | "real" | null;
  llm: "mock" | "ollama" | null;
  timeoutS: number | null;
  runsDir: string;
  casesDir: string;
} {
  const flags = {
    caseId: null as string | null,
    noCache: false,
    planOnly: false,
    backend: null as "fake" | "real" | null,
    llm: null as "mock" | "ollama" | null,
    timeoutS: null as number | null,
    runsDir: DEFAULT_RUNS_DIR,
    casesDir: DEFAULT_CASES_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--case") {
      flags.caseId = argv[i + 1] ?? null;
      i++;
    } else if (a === "--no-cache") {
      flags.noCache = true;
    } else if (a === "--plan-only") {
      flags.planOnly = true;
    } else if (a === "--backend") {
      const v = argv[i + 1];
      if (v === "fake" || v === "real") flags.backend = v;
      i++;
    } else if (a === "--llm") {
      const v = argv[i + 1];
      if (v === "mock" || v === "ollama") flags.llm = v;
      i++;
    } else if (a === "--timeout") {
      flags.timeoutS = Number(argv[i + 1]);
      i++;
    } else if (a === "--runs-dir") {
      flags.runsDir = argv[i + 1] ?? flags.runsDir;
      i++;
    } else if (a === "--cases-dir") {
      flags.casesDir = argv[i + 1] ?? flags.casesDir;
      i++;
    }
  }
  return flags;
}

export async function runBenchmark(argv: string[]): Promise<number> {
  loadEnv();
  const flags = parseFlags(argv);
  const mode = runModeFromEnv(flags.backend ?? undefined, flags.llm ?? undefined);

  const bench = loadCasePack();
  const cases = flags.caseId ? bench.filter((c) => c.case_id === flags.caseId) : bench;
  if (cases.length === 0) {
    const known = bench.map((c) => c.case_id).join(", ");
    process.stderr.write(`no case matched "${flags.caseId}". Known: ${known}\n`);
    return 2;
  }

  const id = runId();
  const runDir = path.join(flags.runsDir, id);
  const perfTarget = Number(env("PERF_TARGET_S", "180"));

  process.stdout.write(`case pack: ${cases.length} case(s), chronological by opened_at\n`);
  process.stdout.write(`mode: TOOLS_BACKEND=${mode.toolsBackend} LLM_BACKEND=${mode.llmBackend} model=${mode.model}\n`);
  process.stdout.write(`replays: ${flags.noCache ? "disabled" : "enabled (.cache/answers/)"} timeout: ${flags.timeoutS ?? "env(default)"}s\n`);
  if (mode.llmBackend === "ollama" && mode.model) {
    process.stdout.write(`ollama model: ${env("OLLAMA_MODEL", "llama3.1")}\n`);
  }

  return runAll({ cases, mode, flags, runDir, perfTarget });
}

async function runAll(opts: {
  cases: ReturnType<typeof loadCasePack>;
  mode: RunMode;
  flags: ReturnType<typeof parseFlags>;
  runDir: string;
  perfTarget: number;
}): Promise<number> {
  const { cases, mode, flags, runDir, perfTarget } = opts;

  if (flags.planOnly) {
    process.stdout.write(`plan-only: would run ${cases.length} case(s) → runs/${path.basename(runDir)}/ + cases/. No cases executed.\n`);
    return 0;
  }

  const problems = await preflight(mode);
  for (const p of problems) process.stderr.write(`preflight: ${p}\n`);

  const runs: CaseRun[] = [];
  let failed = 0;

  mkdirSync(runDir, { recursive: true });
    const summaryPath = path.join(runDir, "summary.jsonl");
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const started = Date.now();
      process.stdout.write(`[${i + 1}/${cases.length}] ${c.case_id} opened ${c.opened_at} (${c.trigger_type}) …`);
      const run = await runOne(c, {
        noCache: flags.noCache,
        toolsBackend: flags.backend ?? undefined,
        llmBackend: flags.llm ?? undefined,
        caseTimeoutS: flags.timeoutS ?? undefined,
      });
      const line: Record<string, unknown> = {
        case_id: c.case_id,
        ok: run.error === null,
        verdict: run.answer?.case.verdict ?? null,
        pattern: run.answer?.case.pattern ?? null,
        status: run.answer?.case.status ?? null,
        tool_calls: run.toolCalls,
        tokens: run.tokens,
        latency_s: run.error ? null : Number((run.latencyMs / 1000).toFixed(1)),
        from_cache: run.fromCache,
        error: run.error,
      };
      writeFileSync(path.join(runDir, `${c.case_id}.raw.json`), JSON.stringify(run, null, 2) + "\n", "utf8");
      appendFileSync(summaryPath, JSON.stringify(line) + "\n", "utf8");
      runs.push(run);
      const latencyS = (Date.now() - started) / 1000;
      const verdict = run.error ? `ERROR (${run.error.slice(0, 60)})` : `${run.answer?.case.verdict}/${run.answer?.case.pattern}`;
      const perf = run.error === null && latencyS > perfTarget ? " ⚠ SLOW" : "";
      process.stdout.write(` ${verdict} ${latencyS.toFixed(1)}s${perf}\n`);
      if (run.error) failed++;
    }

  writeAnswersDir(runs, flags.casesDir);

  const nAns = runs.filter((r) => r.answer).length;
  process.stdout.write(`\n${nAns}/${cases.length} answered → ${flags.casesDir}\n`);
  process.stdout.write(`raw runs → ${runDir}\n`);
  process.stdout.write(`next: pnpm validate-answers  (or make validate-answers)\n`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("runBenchmark.ts")) {
  runBenchmark(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`run-benchmark failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}