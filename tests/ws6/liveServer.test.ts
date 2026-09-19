import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Anything sticky is irrelevant for live runs, but keep the same module
// ordering as server.test.ts (set before server.ts is imported).
process.env.WS6_REPLAY_INTERVAL_MS = "3";

import type { AgentEvent } from "../../contracts/src/agentEvent.js";
import { LiveRunSource, type LiveRunner } from "../../api/src/liveRunSource.js";
import { FixtureRunSource } from "../../api/src/runSource.js";

const { buildServer } = await import("../../api/src/server.js");
type FastifyInstanceType = Awaited<ReturnType<typeof buildServer>>;

const fixtureAnswer = new FixtureRunSource().getRecording("HHG-910")?.answer;

function makeLiveEvents(caseId: string): AgentEvent[] {
  const ts = new Date().toISOString();
  return [
    {
      seq: 0,
      ts,
      case_id: caseId,
      type: "state_entered",
      state: "TRIGGERED",
      payload: {
        trigger: { kind: "risk_score", txn_id: "3514030", card_id: "C12382-K1", risk_score: 0.61 },
      },
    },
    { seq: 1, ts, case_id: caseId, type: "state_entered", state: "INVESTIGATING", payload: {} },
    {
      seq: 2,
      ts,
      case_id: caseId,
      type: "approval_requested",
      state: "APPROVAL_ROUTING",
      payload: { action: "BLOCK_CARD", route: "L1", reason: "test" },
    },
    { seq: 3, ts, case_id: caseId, type: "done", state: "DONE", payload: { stop_reason: "test" } },
  ];
}

function makeRunner(): LiveRunner {
  return async (options, onEvent) => {
    for (const event of makeLiveEvents(options.caseId)) onEvent(event);
    return { answer: fixtureAnswer! };
  };
}

describe("live server routes (WS6, RUN_SOURCE=live)", () => {
  let app: FastifyInstanceType;

  beforeAll(async () => {
    app = buildServer({ runSource: new LiveRunSource({ runner: makeRunner() }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/cases lists the 20 benchmark cases as live-runnable (no fixture demos)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cases" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cases: Array<{ case_id: string; source: string; status: string; has_recording: boolean }>;
    };
    expect(body.cases).toHaveLength(20);
    const ids = body.cases.map((c) => c.case_id);
    expect(ids).toContain("HHG-001");
    expect(ids).toContain("HHG-020");
    expect(ids).not.toContain("HHG-910");
    const entry = body.cases.find((c) => c.case_id === "HHG-001");
    expect(entry?.source).toBe("case_pack");
    expect(entry?.has_recording).toBe(true); // a live session exists for every supported case
    expect(entry?.status).toBe("idle"); // listing does not start runs
  });

  it("GET /api/cases/:id starts a live run and the answer appears once done", async () => {
    const detail = await app.inject({ method: "GET", url: "/api/cases/HHG-001" });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.session.status).toBe("running");
    expect(Array.isArray(body.session.pending_approvals)).toBe(true);
    expect(body.answer).toBeNull();

    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const res = await app.inject({ method: "GET", url: "/api/cases/HHG-001/answer" });
      if (res.statusCode === 200) {
        done = true;
        expect(res.json().answer.case_id).toBe("HHG-910");
      }
    }
    expect(done).toBe(true);

    const after = await app.inject({ method: "GET", url: "/api/cases/HHG-001" });
    const afterBody = after.json();
    expect(afterBody.session.status).toBe("done");
    expect(afterBody.session.emitted_event_count).toBe(4);
    expect(afterBody.session.pending_approvals.map((p: { action: string }) => p.action)).toEqual([
      "BLOCK_CARD",
    ]);
    expect(afterBody.answer?.case.verdict).toBeTruthy();
  });

  it("exposes live pending approvals and lets the UI resolve one", async () => {
    const pendingRes = await app.inject({ method: "GET", url: "/api/approvals" });
    const { pending } = pendingRes.json() as {
      pending: Array<{ case_id: string; action: string }>;
    };
    const forCase = pending.filter((p) => p.case_id === "HHG-001").map((p) => p.action);
    expect(forCase).toEqual(["BLOCK_CARD"]);

    const decide = await app.inject({
      method: "POST",
      url: "/api/cases/HHG-001/approvals/BLOCK_CARD/decision",
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/approvals" });
    const stillPending = (after.json() as { pending: Array<{ case_id: string; action: string }> }).pending.filter(
      (p) => p.case_id === "HHG-001",
    );
    expect(stillPending).toHaveLength(0);
  });

  it("POST /api/cases registers a live ad-hoc case that runs when opened", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/cases",
      payload: {
        trigger: { kind: "customer_report", customer_id: "C90000", txn_ids: ["999"], text: "live adhoc" },
      },
    });
    expect(post.statusCode).toBe(201);
    const { case_id } = post.json() as { case_id: string };
    expect(case_id).toMatch(/^ADHOC-/);

    const list = await app.inject({ method: "GET", url: "/api/cases" });
    const cases = (list.json() as { cases: Array<{ case_id: string; source: string }> }).cases;
    expect(cases).toHaveLength(21);
    const adhoc = cases.find((c) => c.case_id === case_id);
    expect(adhoc?.source).toBe("adhoc");
  });
});

describe("live SSE over a real listening server (WS6)", () => {
  let app: FastifyInstanceType;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildServer({ runSource: new LiveRunSource({ runner: makeRunner() }) });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
  });

  it("streams a live run's events over SSE in seq order and ends with a done event", async () => {
    // HHG-002 is untouched on this fresh server instance, so subscribing is
    // what starts the (fake) live run.
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/cases/HHG-002/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const seqsSeen: number[] = [];
    let sawStreamDone = false;
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline && !sawStreamDone) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        if (chunk.startsWith("event: stream_done")) {
          sawStreamDone = true;
        }
        if (chunk.startsWith("event: agent_event")) {
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            const parsed = JSON.parse(dataLine.slice("data: ".length)) as { seq: number };
            seqsSeen.push(parsed.seq);
          }
        }
      }
    }
    controller.abort();

    expect(sawStreamDone).toBe(true);
    expect(seqsSeen).toEqual([0, 1, 2, 3]);
  }, 10000);
});