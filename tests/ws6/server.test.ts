import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Set the replay pace before any module under test is evaluated so fixture
// runs finish in milliseconds during tests instead of ~10s of wall clock.
process.env.WS6_REPLAY_INTERVAL_MS = "3";

const { buildServer } = await import("../../api/src/server.js");
type FastifyInstanceType = Awaited<ReturnType<typeof buildServer>>;

describe("api/src/server.ts routes (WS6)", () => {
  let app: FastifyInstanceType;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /api/cases lists the 20 benchmark cases plus the 2 fixture demo runs", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cases" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cases: Array<{ case_id: string; source: string }> };
    const ids = body.cases.map((c) => c.case_id);
    expect(ids).toContain("HHG-001");
    expect(ids).toContain("HHG-020");
    expect(ids).toContain("HHG-910");
    expect(ids).toContain("HHG-920");
    expect(body.cases).toHaveLength(22);
    const packEntry = body.cases.find((c) => c.case_id === "HHG-001");
    expect(packEntry?.source).toBe("case_pack");
    const fixtureEntry = body.cases.find((c) => c.case_id === "HHG-910");
    expect(fixtureEntry?.source).toBe("fixture_demo");
  });

  it("GET /api/cases/:id 404s for a truly unknown case", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cases/NOPE-999" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/cases/:id returns the case-pack entry for a real benchmark case with no recording", async () => {
    const res = await app.inject({ method: "GET", url: "/api/cases/HHG-002" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.case_pack_entry.card_id).toBe("C11891-K1");
    expect(body.has_recording).toBe(false);
    expect(body.answer).toBeNull();
  });

  it("POST /api/cases records an ad-hoc trigger and it then appears in the case list", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/cases",
      payload: { trigger: { kind: "analyst_request", entity: { type: "Card", id: "C00001-K1" }, question: "test" } },
    });
    expect(post.statusCode).toBe(201);
    const { case_id } = post.json() as { case_id: string };
    expect(case_id).toMatch(/^ADHOC-/);

    const list = await app.inject({ method: "GET", url: "/api/cases" });
    const ids = (list.json() as { cases: Array<{ case_id: string }> }).cases.map((c) => c.case_id);
    expect(ids).toContain(case_id);
  });

  it("GET /api/cases/:id/answer is 202 with no answer before the run finishes, then the fixture answer once done", async () => {
    // HHG-920 has never been touched by an earlier test in this describe
    // block up to this point, so this also exercises "first touch starts it".
    const first = await app.inject({ method: "GET", url: "/api/cases/HHG-920/answer" });
    expect(first.statusCode).toBe(202);

    // Poll briefly until the fast-paced replay finishes.
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const res = await app.inject({ method: "GET", url: "/api/cases/HHG-920/answer" });
      if (res.statusCode === 200) {
        done = true;
        expect(res.json().answer.case_id).toBe("HHG-920");
      }
    }
    expect(done).toBe(true);
  });
});

describe("SSE + approvals over a real listening server (WS6)", () => {
  let app: FastifyInstanceType;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildServer();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;
  });

  afterAll(async () => {
    await app.close();
  });

  it("streams HHG-910's recorded events over SSE in seq order and ends with a done event", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/cases/HHG-910/events`, { signal: controller.signal });
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
    expect(seqsSeen.length).toBeGreaterThan(20); // HHG-910's fixture has 28 events
    for (let i = 1; i < seqsSeen.length; i++) {
      expect(seqsSeen[i]).toBeGreaterThan(seqsSeen[i - 1]!);
    }
  }, 10000);

  it("exposes HHG-910's two unresolved approvals and lets the UI approve one", async () => {
    // The SSE test above already fully replayed HHG-910 on this same app
    // instance (sessions are cached by case_id), so pending approvals
    // should already be populated.
    const pendingRes = await fetch(`${baseUrl}/api/approvals`);
    const { pending } = (await pendingRes.json()) as {
      pending: Array<{ case_id: string; action: string }>;
    };
    const forCase = pending.filter((p) => p.case_id === "HHG-910");
    const actions = forCase.map((p) => p.action).sort();
    expect(actions).toEqual(["BLOCK_CARD", "FILE_REPORT"]);

    const decide = await fetch(`${baseUrl}/api/cases/HHG-910/approvals/BLOCK_CARD/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(decide.status).toBe(200);

    const afterRes = await fetch(`${baseUrl}/api/approvals`);
    const after = (await afterRes.json()) as { pending: Array<{ case_id: string; action: string }> };
    const stillPending = after.pending.filter((p) => p.case_id === "HHG-910").map((p) => p.action);
    expect(stillPending).toEqual(["FILE_REPORT"]);
  });

  it("400s a decision with a bad body and 409s a decision for an already-resolved action", async () => {
    const bad = await fetch(`${baseUrl}/api/cases/HHG-910/approvals/FILE_REPORT/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(bad.status).toBe(400);

    const alreadyResolved = await fetch(`${baseUrl}/api/cases/HHG-910/approvals/BLOCK_CARD/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(alreadyResolved.status).toBe(409);
  });
});
