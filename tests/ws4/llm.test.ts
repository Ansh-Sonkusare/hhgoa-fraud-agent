import { describe, it, expect, vi } from "vitest";
import { MockLlmClient, OllamaLlmClient, OpenAiCompatLlmClient, script } from "../../agent/src/llm.js";
import type { LlmCall } from "../../agent/src/llm.js";

describe("MockLlmClient", () => {
  it("serves scripted entries in order and repeats the last entry", async () => {
    const llm = new MockLlmClient([script.json({ a: 1 }), script.text("second")]);
    const call: LlmCall = { messages: [], jsonMode: true };
    const r1 = await llm.complete(call);
    const r2 = await llm.complete(call);
    const r3 = await llm.complete(call);
    expect(r1.text).toBe('{"a":1}');
    expect(r2.text).toBe("second");
    expect(r3.text).toBe("second");
    expect(llm.callCount).toBe(3);
  });

  it("honors the optional when() predicate", async () => {
    const llm = new MockLlmClient([
      { text: "ok", when: (c) => c.messages[0]?.content === "hello" },
    ]);
    await expect(llm.complete({ messages: [] })).rejects.toThrow("rejected");
    const r = await llm.complete({ messages: [{ role: "user", content: "hello" }] });
    expect(r.text).toBe("ok");
  });

  it("reset() rewinds the cursor and call history", async () => {
    const llm = new MockLlmClient([script.json({ x: 1 })]);
    await llm.complete({ messages: [] });
    llm.reset();
    expect(llm.callCount).toBe(0);
    const r = await llm.complete({ messages: [] });
    expect(r.text).toBe('{"x":1}');
  });
});

describe("OllamaLlmClient", () => {
  it("POSTs to /api/chat with jsonMode → format:json and returns content", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          message: { content: '{"fraud_type":"card_testing"}' },
          prompt_eval_count: 11,
          eval_count: 7,
        }),
        { status: 200 },
      ),
    );
    const client = new OllamaLlmClient({ baseUrl: "http://lb:11434/", model: "m", fetchFn });
    const r = await client.complete({ messages: [{ role: "user", content: "hi" }], jsonMode: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://lb:11434/api/chat");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["format"]).toBe("json");
    expect(body["stream"]).toBe(false);
    expect(body["model"]).toBe("m");
    expect(r.text).toBe('{"fraud_type":"card_testing"}');
    expect(r.model).toBe("m");
    expect(r.usage.output_tokens).toBe(7);
  });

  it("throws a descriptive error on HTTP failure", async () => {
    const fetchFn = vi.fn(async () => new Response("down", { status: 500 }));
    const client = new OllamaLlmClient({ baseUrl: "http://lb:11434", fetchFn });
    await expect(client.complete({ messages: [] })).rejects.toThrow(/ollama serve/);
  });

  it("rejects a response without a message.content string", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const client = new OllamaLlmClient({ fetchFn });
    await expect(client.complete({ messages: [] })).rejects.toThrow(/missing message.content/);
  });
});

describe("OpenAiCompatLlmClient", () => {
  it("POSTs to /v1/chat/completions with jsonMode → response_format json_object and returns content", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "qwen2.5-7b",
          choices: [{ message: { content: '{"fraud_type":"card_testing"}' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200 },
      ),
    );
    const client = new OpenAiCompatLlmClient({ baseUrl: "http://localhost:8080/", model: "qwen2.5-7b", fetchFn });
    const r = await client.complete({ messages: [{ role: "user", content: "hi" }], jsonMode: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/v1/chat/completions");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["stream"]).toBe(false);
    expect(body["model"]).toBe("qwen2.5-7b");
    expect(r.text).toBe('{"fraud_type":"card_testing"}');
    expect(r.model).toBe("qwen2.5-7b");
    expect(r.usage.input_tokens).toBe(11);
    expect(r.usage.output_tokens).toBe(7);
  });

  it("defaults model to LLM_MODEL over OLLAMA_MODEL", () => {
    const prevLlm = process.env["LLM_MODEL"];
    const prevOllama = process.env["OLLAMA_MODEL"];
    process.env["LLM_MODEL"] = "Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M";
    process.env["OLLAMA_MODEL"] = "qwen2.5:1.5b";
    try {
      const client = new OpenAiCompatLlmClient();
      expect(client.model).toBe("Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M");
    } finally {
      if (prevLlm === undefined) delete process.env["LLM_MODEL"];
      else process.env["LLM_MODEL"] = prevLlm;
      if (prevOllama === undefined) delete process.env["OLLAMA_MODEL"];
      else process.env["OLLAMA_MODEL"] = prevOllama;
    }
  });

  it("throws a descriptive error on HTTP failure", async () => {
    const fetchFn = vi.fn(async () => new Response("down", { status: 500 }));
    const client = new OpenAiCompatLlmClient({ baseUrl: "http://localhost:8080", fetchFn });
    await expect(client.complete({ messages: [] })).rejects.toThrow(/llama-server/);
  });

  it("rejects a response without choices[0].message.content", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }));
    const client = new OpenAiCompatLlmClient({ fetchFn });
    await expect(client.complete({ messages: [] })).rejects.toThrow(/choices\[0\]\.message\.content/);
  });
})