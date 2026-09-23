/**
 * LLM client abstraction (PRD §9.3, "assessor prompt"-adjacent, and §9.4).
 *
 * Two implementations:
 *  - `OllamaLlmClient` talks to a local Ollama server over plain HTTP
 *    (`POST {baseUrl}/api/chat`, `stream: false`). Per the coordinator the
 *    LLM backend for this round is local Ollama (`LLM_BACKEND=ollama`,
 *    `OLLAMA_URL`, `OLLAMA_MODEL`), not the Anthropic API that the worktree
 *    `.env.example` still references from an earlier milestone. A real
 *    Ollama server is not running in this worktree, so tests are never
 *    allowed to hit it — they use `MockLlmClient`.
 *  - `OpenAiCompatLlmClient` talks to any OpenAI-compatible chat endpoint
 *    (`POST {baseUrl}/v1/chat/completions`, `stream: false`) — e.g. a local
 *    llama.cpp `llama-server` (`LLM_BACKEND=openai`, `LLM_BASE_URL`,
 *    `LLM_MODEL`), which does not speak Ollama's `/api/chat` protocol.
 *  - `MockLlmClient` is a deterministic in-memory script (used by every
 *    test and as the default when `LLM_BACKEND=mock`). It returns texts
 *    verbatim from a script, so full machine runs are reproducible without
 *    a live LLM (PRD §13, §15).
 *
 * The interface is deliberately small: `complete(call)` returns a plain
 * message string; callers that need structured output validate it through
 * `structured.ts`.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCall {
  system?: string;
  messages: LlmMessage[];
  /** Ollama supports temperature via `options`; default is server-side. */
  temperature?: number;
  /** Ask the model to stream JSON back (Ollama `format: "json"`). */
  jsonMode?: boolean;
  /**
   * JSON Schema the reply must satisfy. On an OpenAI-compatible server that
   * supports it (llama.cpp does, via GBNF) this constrains decoding, so the
   * shape is guaranteed rather than hoped for — `json_object` alone only
   * promises *valid* JSON, which is how a 7B model came to flatten
   * `hypotheses[]` into top-level keys and fail every parse.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface LlmResult {
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface LlmClient {
  readonly model: string;
  complete(call: LlmCall): Promise<LlmResult>;
}

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  /** Waits between retries; injectable so tests do not sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Give up after this long spent retrying (ms). Default LLM_RETRY_MAX_WAIT_S, 900 s. */
  maxRetryWaitMs?: number;
}

function envOr(fallback: string, envName: string): string {
  const v = process.env[envName];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

/** Real Ollama client (`LLM_BACKEND=ollama`). Never used by tests. */
export class OllamaLlmClient implements LlmClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? envOr("llama3.1", "OLLAMA_MODEL");
    // Repo convention is OLLAMA_HOST (PRD §5, .env); OLLAMA_URL kept as a legacy alias.
    const hostFromEnv = process.env["OLLAMA_HOST"] ?? process.env["OLLAMA_URL"];
    this.baseUrl = opts.baseUrl ?? envOr("http://localhost:11434", hostFromEnv ?? "OLLAMA_URL");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? Number(process.env["LLM_RETRY_MAX_WAIT_S"] ?? "900") * 1000;
  }

  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxRetryWaitMs: number;

  /**
   * One chat completion, retried while the server is unavailable. A run with
   * several cases in flight must not lose a case because llama-server was
   * restarting, busy or briefly out of KV cache: the call waits with backoff
   * (2 s doubling to 30 s) and tries again, up to maxRetryWaitMs in total.
   */
  async complete(call: LlmCall): Promise<LlmResult> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.completeOnce(call);
      } catch (err) {
        const delay = Math.min(30_000, 2_000 * 2 ** attempt);
        if (!isRetryableLlmFailure(err) || waited + delay > this.maxRetryWaitMs) throw err;
        const why = err instanceof Error ? err.message.slice(0, 160) : String(err);
        process.stderr.write(`llm: attempt ${attempt + 1} failed (${why}); retrying in ${delay / 1000}s\n`);
        await this.sleepFn(delay);
        waited += delay;
      }
    }
  }

  private async completeOnce(call: LlmCall): Promise<LlmResult> {
    const messages: LlmMessage[] = [];
    if (call.system) messages.push({ role: "system", content: call.system });
    if (call.messages.length > 0) messages.push(...call.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (call.jsonMode) body["format"] = "json";
    if (call.temperature !== undefined) body["options"] = { temperature: call.temperature };

    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new LlmHttpError(
        `OllamaLlmClient: ${this.baseUrl}/api/chat failed with HTTP ${res.status} ` +
          `(${this.model}); is ` +
          `"ollama serve" running and ${this.model} pulled?`,
        res.status,
      );
    }
    const payload: unknown = await res.json();
    const message = (payload as { message?: { content?: unknown } }).message;
    if (!message || typeof message.content !== "string") {
      throw new LlmResponseError(`OllamaLlmClient: /api/chat response missing message.content`);
    }
    const usage = payload as {
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      text: message.content,
      model: this.model,
      usage: {
        input_tokens: usage.prompt_eval_count ?? 0,
        output_tokens: usage.eval_count ?? 0,
      },
    };
  }
}

export interface OpenAiCompatOptions {
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  /** Waits between retries; injectable so tests do not sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Give up after this long spent retrying (ms). Default LLM_RETRY_MAX_WAIT_S, 900 s. */
  maxRetryWaitMs?: number;
}

/**
 * Whether a failed call is worth repeating: the server was unreachable, timed
 * out, overloaded or restarting (network error, abort, HTTP 429/5xx). A 4xx
 * such as a prompt larger than the context is deterministic and is not retried.
 */
export function isRetryableLlmFailure(err: unknown): boolean {
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  // A server that answered with a malformed body is up; asking again will not help.
  if (err instanceof LlmResponseError) return false;
  return true;
}

export class LlmResponseError extends Error {}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * OpenAI-compatible chat client (`LLM_BACKEND=openai`). Talks to any server
 * speaking the OpenAI `/v1/chat/completions` shape — a local llama.cpp
 * `llama-server` (`llama-server -hf Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M`),
 * for example, which does not implement Ollama's `/api/chat`. Never used by
 * tests (they inject `fetchFn` or use `MockLlmClient`).
 */
export class OpenAiCompatLlmClient implements LlmClient {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpenAiCompatOptions = {}) {
    // LLM_MODEL wins over OLLAMA_MODEL so a llama.cpp-backed run can name
    // its own checkpoint without touching the Ollama configuration.
    this.model = opts.model ?? envOr(envOr("llama3.1", "OLLAMA_MODEL"), "LLM_MODEL");
    this.baseUrl = opts.baseUrl ?? envOr("http://localhost:8080", "LLM_BASE_URL");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? Number(process.env["LLM_RETRY_MAX_WAIT_S"] ?? "900") * 1000;
  }

  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly maxRetryWaitMs: number;

  /**
   * One chat completion, retried while the server is unavailable. A run with
   * several cases in flight must not lose a case because llama-server was
   * restarting, busy or briefly out of KV cache: the call waits with backoff
   * (2 s doubling to 30 s) and tries again, up to maxRetryWaitMs in total.
   */
  async complete(call: LlmCall): Promise<LlmResult> {
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.completeOnce(call);
      } catch (err) {
        const delay = Math.min(30_000, 2_000 * 2 ** attempt);
        if (!isRetryableLlmFailure(err) || waited + delay > this.maxRetryWaitMs) throw err;
        const why = err instanceof Error ? err.message.slice(0, 160) : String(err);
        process.stderr.write(`llm: attempt ${attempt + 1} failed (${why}); retrying in ${delay / 1000}s\n`);
        await this.sleepFn(delay);
        waited += delay;
      }
    }
  }

  private async completeOnce(call: LlmCall): Promise<LlmResult> {
    const messages: LlmMessage[] = [];
    if (call.system) messages.push({ role: "system", content: call.system });
    if (call.messages.length > 0) messages.push(...call.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: call.temperature ?? 0.7,
      stream: false,
    };
    if (call.jsonSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: call.jsonSchema.name, strict: true, schema: call.jsonSchema.schema },
      };
    } else if (call.jsonMode) {
      body["response_format"] = { type: "json_object" };
    }

    // A request that never completes must fail this call, not freeze the run.
    // Without a signal, one stalled generation held a 20-case backtest at case
    // 5 for 27 minutes with the worker idle in epoll_wait; the per-case
    // deadline in eval/ never rescued it. Generous by default: the largest
    // prompt seen is ~8k tokens at ~2k tok/s prefill plus a few hundred tokens
    // at ~43 tok/s, so a healthy call finishes in well under a minute.
    const timeoutMs = Number(process.env["LLM_REQUEST_TIMEOUT_S"] ?? "300") * 1000;
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.text();
        detail = body.trim().slice(0, 300);
      } catch {
        // body not readable; fall through to the generic error
      }
      throw new LlmHttpError(
        `OpenAiCompatLlmClient: ${this.baseUrl}/v1/chat/completions failed with HTTP ${res.status} ` +
          `(${this.model}); is a llama.cpp/Ollama llama-server (or other OpenAI-compatible ` +
          `endpoint) running at ${this.baseUrl}?${detail ? ` server said: ${detail}` : ""}`,
        res.status,
      );
    }
    const payload: unknown = await res.json();
    const choices = (payload as { choices?: { message?: { content?: unknown } }[] }).choices;
    const content = choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new LlmResponseError(`OpenAiCompatLlmClient: /v1/chat/completions response missing choices[0].message.content`);
    }
    const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    return {
      text: content,
      model: (payload as { model?: unknown }).model && typeof (payload as { model?: unknown }).model === "string"
        ? ((payload as { model: string }).model)
        : this.model,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    };
  }
}

export interface MockScriptEntry {
  /** Text the mock returns. `undefined` works too (empty reply). */
  text?: string;
  /** Convenience: JSON-serialize an object as the scripted text. */
  json?: unknown;
  /** Optional predicate to match a specific call (by inspection). */
  when?: (call: LlmCall) => boolean;
}

export interface MockLlmOptions {
  model?: string;
}

/**
 * Deterministic scripted LLM. Script entries are consumed in order; the
 * last entry repeats for any further calls. Every test in tests/ws4 runs
 * through this client so full runs are reproducible without a live model.
 */
export class MockLlmClient implements LlmClient {
  readonly model: string;
  private readonly script: readonly MockScriptEntry[];
  private cursor = 0;
  private readonly calls: LlmCall[] = [];

  constructor(script: readonly MockScriptEntry[] = [], opts: MockLlmOptions = {}) {
    this.script = script;
    this.model = opts.model ?? "mock-llama3.1";
  }

  async complete(call: LlmCall): Promise<LlmResult> {
    this.calls.push(call);
    // Repeat the last entry once the script is exhausted (documented above).
    const last = this.script.length === 0 ? 0 : this.script.length - 1;
    const entry = this.script[Math.min(this.cursor, last)] ?? {};
    this.cursor += 1;
    if (entry.when && !entry.when(call)) {
      throw new Error(`MockLlmClient: script entry ${this.cursor - 1} rejected the call`);
    }
    const text =
      entry.text ??
      (entry.json !== undefined
        ? typeof entry.json === "string"
          ? entry.json
          : (JSON.stringify(entry.json) as string)
        : "");
    return { text, model: this.model, usage: { input_tokens: 0, output_tokens: text.length } };
  }

  /** Count of calls made so far (used by tests to assert LLM round-trips). */
  get callCount(): number {
    return this.calls.length;
  }

  reset(): void {
    this.cursor = 0;
    this.calls.length = 0;
  }
}

/** Helpers for writing scripts concisely. */
export const script = {
  text(text: string): MockScriptEntry {
    return { text };
  },
  json(obj: unknown): MockScriptEntry {
    return { json: obj };
  },
};