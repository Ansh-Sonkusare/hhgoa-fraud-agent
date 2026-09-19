import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { CASE_PACK, findCasePackEntry, type CasePackEntry } from "./data/casePack.js";
import { FixtureRunSource, type RunSource } from "./runSource.js";
import { ReplaySessionRegistry } from "./replaySession.js";

export interface BuildServerOptions {
  runSource?: RunSource;
}

interface AdhocTrigger {
  case_id: string;
  created_at: string;
  trigger: unknown;
}

/**
 * Builds (but does not start listening on) the Fastify app. Exported so
 * `tests/ws6/*.test.ts` can exercise routes via `app.inject(...)` without
 * binding a real port, and so `src/index.ts` stays a thin entrypoint.
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const runSource = options.runSource ?? new FixtureRunSource();
  const sessions = new ReplaySessionRegistry((caseId) => runSource.getRecording(caseId));
  const adhocTriggers = new Map<string, AdhocTrigger>();

  const app = Fastify({ logger: false });

  app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  // --- Case queue -----------------------------------------------------

  app.get("/api/cases", async () => {
    const fromPack = CASE_PACK.map((entry) => summarize(entry, "case_pack"));
    const fixtureIds = runSource
      .listKnownCaseIds()
      .filter((id) => !findCasePackEntry(id)); // don't double-count if a fixture ever reuses a real case_id
    const fromFixtures = fixtureIds.map((id) => {
      const recording = runSource.getRecording(id);
      const trigger = recording?.events[0]?.payload["trigger"] as
        | { kind?: string; txn_id?: string; card_id?: string; risk_score?: number }
        | undefined;
      const entry: CasePackEntry = {
        case_id: id,
        opened_at: recording?.events[0]?.ts ?? "",
        trigger_type: (trigger?.kind as CasePackEntry["trigger_type"]) ?? "risk_score",
        flagged_txn_id: trigger?.txn_id ?? "",
        card_id: trigger?.card_id ?? "",
        customer_id: "",
        risk_score: trigger?.risk_score ?? null,
        trigger_text: "Fixture demo run (WS0 recorded example, not one of the 20 benchmark cases).",
      };
      return summarize(entry, "fixture_demo");
    });
    const fromAdhoc = [...adhocTriggers.values()].map((t) => ({
      case_id: t.case_id,
      opened_at: t.created_at,
      trigger_type: (t.trigger as { kind?: string })?.kind ?? "unknown",
      trigger_text: "Ad-hoc trigger submitted via the UI's \"new trigger\" form.",
      flagged_txn_id: "",
      card_id: "",
      customer_id: "",
      risk_score: null,
      source: "adhoc" as const,
      has_recording: false,
      status: "no_recording" as const,
      verdict: null,
      fraud_probability: null,
    }));
    return { cases: [...fromPack, ...fromFixtures, ...fromAdhoc] };

    function summarize(entry: CasePackEntry, source: "case_pack" | "fixture_demo") {
      const session = sessions.getOrCreate(entry.case_id);
      const answer = session?.getAnswer() ?? null;
      return {
        ...entry,
        source,
        has_recording: session !== null,
        status: session ? session.getStatus() : "no_recording",
        verdict: answer?.case.verdict ?? null,
        fraud_probability: answer?.case.fraud_probability ?? null,
      };
    }
  });

  app.post("/api/cases", async (request, reply) => {
    const body = request.body as { trigger?: unknown } | undefined;
    if (!body || typeof body !== "object" || body.trigger === undefined) {
      return reply.code(400).send({ error: "body must be { trigger: {...} }" });
    }
    const case_id = `ADHOC-${randomUUID().slice(0, 8)}`;
    adhocTriggers.set(case_id, {
      case_id,
      created_at: new Date().toISOString(),
      trigger: body.trigger,
    });
    return reply.code(201).send({
      case_id,
      note:
        "Trigger recorded. No live agent is connected yet (WS4's agent/ isn't merged) — this case has no recorded run and /events will report that. Once a live agent lands, this same case_id becomes runnable without any API change (see runSource.ts).",
    });
  });

  app.get("/api/cases/:caseId", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const packEntry = findCasePackEntry(caseId);
    const adhoc = adhocTriggers.get(caseId);
    const recording = runSource.getRecording(caseId);
    if (!packEntry && !adhoc && !recording) {
      return reply.code(404).send({ error: `unknown case_id ${caseId}` });
    }
    const session = sessions.getOrCreate(caseId);
    // Opening the case detail page is what "runs" a case in this fixture
    // world — starting here (idempotent) means a client that never opens
    // the SSE stream still sees the run progress on repeated GETs.
    session?.start();
    return {
      case_id: caseId,
      case_pack_entry: packEntry ?? null,
      adhoc_trigger: adhoc?.trigger ?? null,
      has_recording: session !== null,
      session: session
        ? {
            status: session.getStatus(),
            emitted_event_count: session.getEmittedEvents().length,
            total_event_count: recording?.events.length ?? null,
            pending_approvals: session.getPendingApprovals(),
          }
        : null,
      answer: session?.getAnswer() ?? null,
    };
  });

  app.get("/api/cases/:caseId/answer", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const session = sessions.getOrCreate(caseId);
    if (!session) {
      return reply.code(404).send({ error: `no recorded run for ${caseId}` });
    }
    session.start();
    const answer = session.getAnswer();
    if (!answer) {
      return reply.code(202).send({ status: session.getStatus(), answer: null });
    }
    return { status: "done", answer };
  });

  // --- Live investigation timeline (SSE) -------------------------------

  app.get("/api/cases/:caseId/events", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const session = sessions.getOrCreate(caseId);

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no"); // disable nginx-style buffering if ever proxied
    reply.hijack();
    reply.raw.flushHeaders?.();

    if (!session) {
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({
          message: `No recorded run for case ${caseId} yet. WS4's live agent isn't merged; only fixture-recorded cases (${runSource
            .listKnownCaseIds()
            .join(", ")}) can be replayed today.`,
        })}\n\n`,
      );
      reply.raw.end();
      return;
    }

    let unsubscribe = () => {};
    unsubscribe = session.subscribe((event) => {
      reply.raw.write(`event: agent_event\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done") {
        // A live run finishing: tell the client the replay is complete, but
        // keep the connection open — human decisions after DONE are broadcast
        // as synthetic `action_result` events and the UI shows them as they
        // land. (The connection is closed by the client's unsubscribe, or by
        // the close handler below when the socket goes away.)
        reply.raw.write(`event: stream_done\ndata: {}\n\n`);
      }
    });

    // Late joiner to an already-finished run: the synchronous backlog replay
    // above already delivered the entire run (recorded events plus any
    // synthetic decisions broadcast after DONE), so signal completion and
    // close. Without this the proxy may never flush a response that goes
    // silent right after writing, leaving the client with an empty
    // timeline; and the response would otherwise be held open forever.
    if (session.getStatus() === "done") {
      reply.raw.write(`event: stream_done\ndata: {}\n\n`);
      reply.raw.end();
    }

    request.raw.on("close", () => {
      unsubscribe();
    });
  });

  // --- Approvals inbox --------------------------------------------------

  app.get("/api/approvals", async () => {
    const pending = sessions.all().flatMap((s) => s.getPendingApprovals());
    return { pending };
  });

  app.post("/api/cases/:caseId/approvals/:action/decision", async (request, reply) => {
    const { caseId, action } = request.params as { caseId: string; action: string };
    const body = request.body as { decision?: "approved" | "rejected" } | undefined;
    if (!body || (body.decision !== "approved" && body.decision !== "rejected")) {
      return reply.code(400).send({ error: 'body must be { decision: "approved" | "rejected" }' });
    }
    const session = sessions.get(caseId);
    if (!session) {
      return reply.code(404).send({ error: `no active run for ${caseId}` });
    }
    const resolved = session.resolveApproval(action, body.decision);
    if (!resolved) {
      return reply.code(409).send({ error: `no pending approval for action ${action} on ${caseId}` });
    }
    return { ok: true, action, decision: body.decision };
  });

  return app;
}
