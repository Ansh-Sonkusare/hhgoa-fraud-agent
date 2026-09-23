import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AnswerFile, AgentEvent, Trigger } from "@hhgoa/contracts";
import type { RunResult } from "@hhgoa/agent";
import type { BenchmarkCase } from "./dataset.js";
import { buildTrigger } from "./triggers.js";
import { env, parseSeconds, repoRoot } from "./env.js";

/** Backend selection — switchable exactly like the API (PRD §16 WS6 / §8.6). */
export interface RunMode {
  toolsBackend: "fake" | "real";
  llmBackend: "mock" | "ollama" | "openai";
  model: string;
}

export function runModeFromEnv(tools?: string, llm?: string): RunMode {
  const toolsBackend = ((tools ?? env("TOOLS_BACKEND", "real")) === "real" ? "real" : "fake") as "real" | "fake";
  const llmStr = llm ?? env("LLM_BACKEND", "ollama");
  const llmBackend = (llmStr === "ollama" || llmStr === "openai" ? llmStr : "mock") as "mock" | "ollama" | "openai";
  // Report the model the backend actually calls. The openai client resolves
  // LLM_MODEL before OLLAMA_MODEL (agent/src/llm.ts); reading only
  // OLLAMA_MODEL here stamped answer files with a model that never ran.
  const ollamaModel = env("OLLAMA_MODEL", "llama3.1");
  const model = llmBackend === "openai" ? env("LLM_MODEL", ollamaModel) : llmBackend === "mock" ? "mock" : ollamaModel;
  return { toolsBackend, llmBackend, model };
}

/** Minimal run unit: the machine needs exactly caseId + asOf + trigger (PRD §9.2). */
export interface RunTarget {
  caseId: string;
  asOf: string;
  trigger: Trigger;
}

export function targetFromCasePack(c: BenchmarkCase): RunTarget {
  return { caseId: c.case_id, asOf: c.opened_at, trigger: buildTrigger(c) };
}

/** Result of one case, whether or not the machine finished. */
export interface CaseRun {
  case_id: string;
  mode: RunMode;
  answer: AnswerFile | null;
  events: AgentEvent[];
  toolCalls: number;
  tokens: number;
  latencyMs: number;
  /** non-null when the run errored. */
  error: string | null;
  fromCache: boolean;
  ranAt: string;
}

export interface RunOneOptions {
  toolsBackend?: "fake" | "real";
  llmBackend?: "mock" | "ollama" | "openai";
  /** Skip the `.cache/` replay. */
  noCache?: boolean;
  cacheDir?: string;
  /** Absolute timeout for one case (seconds). Default 0 = none. */
  caseTimeoutS?: number;
  /** Persist the closed case into graph + RAG memory. Backtests pass false. */
  writeBackCase?: boolean;
}

function cacheSlug(case_id: string, mode: RunMode): string {
  return `${case_id}.${mode.toolsBackend}.${mode.llmBackend}.json`;
}

function defaultCacheDir(): string {
  return path.join(repoRoot(), ".cache", "answers");
}

function readCache(file: string): { answer: AnswerFile; events: AgentEvent[]; meta: Record<string, unknown> } | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      answer?: unknown;
      events?: unknown;
      meta?: Record<string, unknown>;
    };
    if (!raw.answer) return null;
    return { answer: raw.answer as AnswerFile, events: (raw.events as AgentEvent[]) ?? [], meta: raw.meta ?? {} };
  } catch {
    return null;
  }
}

/** Preflight for a real-tools batch run: fail fast on an unreachable LLM backend. */
export async function preflight(mode: RunMode): Promise<string[]> {
  const problems: string[] = [];
  if (mode.llmBackend === "ollama") {
    const host = env("OLLAMA_HOST", "http://localhost:11434").replace(/\/$/, "");
    try {
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) problems.push(`Ollama responded ${res.status} at ${host} — is OLLAMA_HOST right?`);
    } catch {
      problems.push(`Ollama not reachable at ${host} (LLM_BACKEND=ollama). Start it or run with LLM_BACKEND=mock.`);
    }
  }
  if (mode.llmBackend === "openai") {
    const base = env("LLM_BASE_URL", "http://localhost:8080").replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) problems.push(`OpenAI-compatible endpoint responded ${res.status} at ${base} — is LLM_BASE_URL right?`);
    } catch {
      problems.push(
        `No OpenAI-compatible endpoint at ${base} (LLM_BACKEND=openai). Start llama-server or run with LLM_BACKEND=mock.`,
      );
    }
  }
  return problems;
}

/**
 * Runs one investigation through the real WS4 machine (`runAgent`) with a
 * run-level replay cache under `.cache/answers/`: the same (case, backend,
 * LLM) deterministically replays on later invocations unless NO_CACHE is
 * set — what makes a 20-case batch idempotent (PRD §15 reproducibility).
 */
async function runTarget(target: RunTarget, queryMode: RunMode, opts: RunOneOptions): Promise<CaseRun> {
  const mode = queryMode;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const cacheFile = path.join(cacheDir, cacheSlug(target.caseId, mode));

  if (!opts.noCache) {
    const hit = readCache(cacheFile);
    if (hit) {
      const meta = hit.meta as { latencyMs?: number; toolCalls?: number; tokens?: number };
      return {
        case_id: target.caseId,
        mode,
        answer: hit.answer,
        events: hit.events,
        toolCalls: meta.toolCalls ?? 0,
        tokens: meta.tokens ?? 0,
        latencyMs: meta.latencyMs ?? 0,
        error: null,
        fromCache: true,
        ranAt: new Date().toISOString(),
      };
    }
  }

  const started = Date.now();
  let answer: AnswerFile | null = null;
  let events: AgentEvent[] = [];
  let toolCalls = 0;
  let tokens = 0;
  let error: string | null = null;

  const timeoutS = opts.caseTimeoutS ?? parseSeconds(env("CASE_TIMEOUT_S", "900"));
  try {
    const { runAgent, createLlmClient } = await import("@hhgoa/agent");
    const llm =
      mode.llmBackend === "ollama" || mode.llmBackend === "openai" ? createLlmClient(mode.llmBackend) : undefined;
    const runPromise = runAgent({
      caseId: target.caseId,
      asOf: target.asOf,
      trigger: target.trigger,
      backend: mode.toolsBackend,
      llm,
      writeBackCase: opts.writeBackCase,
    }).then((r: RunResult) => {
      answer = r.answer;
      events = r.events;
      toolCalls = r.toolCalls;
      tokens = r.tokens;
      return r;
    });
    if (timeoutS > 0) {
      // Lazy reject: Promise.reject() builds an already-rejected promise, so an
      // eager Promise.race() arm would win instantly and every case would fail
      // with "case timeout after Ns" at ~0ms without the machine ever running.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`case timeout after ${timeoutS}s`)), timeoutS * 1000);
      });
      await Promise.race([runPromise, deadline]);
      clearTimeout(timer);
    } else {
      await runPromise;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // A run whose core graph reads failed has nothing to reason from, yet the
  // agent still emits a well-formed answer built from the trigger alone. With
  // TigerGraph answering "System Memory in Critical state" every such case
  // came back card_not_present_fraud in ~8s and was scored as if investigated
  // (iteration 11, docs/logs.md). Record it as an error so it is neither
  // scored nor cached.
  if (!error) error = coreGraphFailure(events);

  const latencyMs = Date.now() - started;
  const run: CaseRun = {
    case_id: target.caseId,
    mode,
    answer,
    events,
    toolCalls,
    tokens,
    latencyMs,
    error,
    fromCache: false,
    ranAt: new Date().toISOString(),
  };

  if (!run.error) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ answer, events, meta: { latencyMs, toolCalls, tokens }, mode }, null, 2));
  }
  return run;
}

/**
 * Graph reads without which a case cannot be investigated: the trigger
 * resolution (which card) and the card's transaction history.
 */
const CORE_GRAPH_TOOLS = new Set(["resolve_trigger", "get_transaction_history"]);

/**
 * Returns an error message when any core graph read in the run failed, else
 * null. Reads the `tool_result` events, whose payload is `{ tool, result }`
 * with `result` a ToolResult envelope.
 */
export function coreGraphFailure(events: AgentEvent[]): string | null {
  const failed: string[] = [];
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    const tool = e.payload["tool"];
    const result = e.payload["result"] as { ok?: unknown; error?: unknown } | undefined;
    if (typeof tool !== "string" || !CORE_GRAPH_TOOLS.has(tool)) continue;
    if (result?.ok === false) {
      failed.push(`${tool}: ${typeof result.error === "string" ? result.error : "failed"}`);
    }
  }
  return failed.length ? `core graph read failed — ${failed.join("; ")}` : null;
}

/** Runs one benchmark case-pack entry (trigger derived from its columns). */
export function runOne(c: BenchmarkCase, opts: RunOneOptions = {}): Promise<CaseRun> {
  return runTarget(targetFromCasePack(c), runModeFromEnv(opts.toolsBackend, opts.llmBackend), opts);
}

/** Runs an arbitrary trigger (backtest: closed-case replays, ad-hoc triggers). */
export function runOneTarget(target: RunTarget, opts: RunOneOptions = {}): Promise<CaseRun> {
  return runTarget(target, runModeFromEnv(opts.toolsBackend, opts.llmBackend), opts);
}