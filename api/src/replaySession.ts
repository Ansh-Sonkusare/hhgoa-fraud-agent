import type { AgentEvent, AnswerFile } from "@hhgoa/contracts";
import type { RunRecording } from "./runSource.js";
import { env } from "./env.js";

export type SessionStatus = "idle" | "running" | "done" | "error";

export interface PendingApproval {
  seq: number;
  case_id: string;
  action: string;
  route: string;
  reason: string;
  ts: string;
}

export type Subscriber = (event: AgentEvent) => void;

/** An event written into a live feed by the API itself (seq/case_id optional — the feed fills them). */
export type ExternalAgentEvent = Omit<AgentEvent, "seq" | "case_id"> & { seq?: number; case_id?: string };

/** The session surface consumed by server routes; both ReplaySession and LiveSession implement it. */
export interface RunSession {
  readonly case_id: string;
  getStatus(): SessionStatus;
  getEmittedEvents(): AgentEvent[];
  getAnswer(): AnswerFile | null;
  getPendingApprovals(): PendingApproval[];
  start(): void;
  subscribe(send: Subscriber): () => void;
  resolveApproval(action: string, decision: "approved" | "rejected"): PendingApproval | null;
}

/**
 * The live half of a case's run source: a `LiveRunSource` (liveRunSource.ts)
 * implements this so `LiveSession` can mirror `ReplaySession`'s surface over
 * a real agent run instead of a recorded one.
 */
export interface LiveFeed {
  supports(caseId: string): boolean;
  start(caseId: string): void;
  subscribe(caseId: string, send: Subscriber): () => void;
  getStatus(caseId: string): SessionStatus;
  getEvents(caseId: string): AgentEvent[];
  getRecording(caseId: string): RunRecording | null;
  getLastError(caseId: string): string | null;
  pushExternalEvent(caseId: string, event: ExternalAgentEvent): void;
}

/**
 * Replays one case's recorded `AgentEvent[]` over "wall clock" time so the
 * UI timeline (§14) can animate the investigation rather than dumping the
 * whole run at once. One session is shared by every SSE subscriber for a
 * given case: the first request to touch a case starts playback; later
 * subscribers (e.g. a page reload) get the backlog replayed instantly, then
 * join the live stream — so the case detail page always reflects the same
 * server-side state regardless of who's watching.
 *
 * Approvals (§10.4, §14 "Approvals inbox"): `approval_requested` events
 * that never get a matching recorded `action_result` (true for every fixture
 * — L1/L2 actions wait for a human by design) become pending approvals.
 * `resolveApproval` appends a synthetic `action_result` event, broadcasts it
 * to subscribers exactly like a recorded one, and clears the pending entry.
 * This is the one place fixture replay isn't purely passive — it's what
 * makes the Approve/Reject buttons in the UI do something real.
 */
export class ReplaySession implements RunSession {
  readonly case_id: string;
  private readonly recording: RunRecording;
  private cursor = 0;
  private status: SessionStatus = "idle";
  private readonly emitted: AgentEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private nextSyntheticSeq: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(recording: RunRecording, private readonly intervalMs: number = env.REPLAY_INTERVAL_MS) {
    this.case_id = recording.case_id;
    this.recording = recording;
    const maxSeq = recording.events.reduce((m, e) => Math.max(m, e.seq), -1);
    this.nextSyntheticSeq = maxSeq + 1;
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  getEmittedEvents(): AgentEvent[] {
    return [...this.emitted];
  }

  getAnswer() {
    return this.status === "done" ? this.recording.answer : null;
  }

  getPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()];
  }

  /** Starts playback if not already running/done. Idempotent. */
  start(): void {
    if (this.status !== "idle") return;
    this.status = "running";
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.cursor >= this.recording.events.length) {
      this.status = "done";
      return;
    }
    this.timer = setTimeout(() => {
      const event = this.recording.events[this.cursor];
      this.cursor += 1;
      if (event) this.emit(event);
      this.scheduleNext();
    }, this.intervalMs);
  }

  private emit(event: AgentEvent): void {
    this.emitted.push(event);
    if (event.type === "approval_requested") {
      const action = String(event.payload["action"] ?? "unknown");
      this.pendingApprovals.set(action, {
        seq: event.seq,
        case_id: this.case_id,
        action,
        route: String(event.payload["route"] ?? "unknown"),
        reason: String(event.payload["reason"] ?? ""),
        ts: event.ts,
      });
    }
    if (event.type === "action_result") {
      const action = String(event.payload["action"] ?? "unknown");
      this.pendingApprovals.delete(action);
    }
    for (const sub of this.subscribers) sub(event);
  }

  /**
   * Registers a live subscriber and immediately replays the backlog to it
   * (synchronously, in order) so a late joiner sees the full history before
   * any new event arrives. Starts playback on first subscription.
   */
  subscribe(send: Subscriber): () => void {
    for (const event of this.emitted) send(event);
    this.subscribers.add(send);
    this.start();
    return () => {
      this.subscribers.delete(send);
    };
  }

  /** Approve/reject an L1/L2 action that's awaiting a human (mock — no real side effects). */
  resolveApproval(action: string, decision: "approved" | "rejected"): PendingApproval | null {
    const pending = this.pendingApprovals.get(action);
    if (!pending) return null;
    const seq = this.nextSyntheticSeq;
    this.nextSyntheticSeq += 1;
    const lastState = this.emitted.at(-1)?.state ?? "APPROVAL_ROUTING";
    const event: AgentEvent = {
      seq,
      ts: new Date().toISOString(),
      case_id: this.case_id,
      type: "action_result",
      state: lastState,
      payload: {
        action,
        result: decision === "approved" ? "EXECUTED" : "DENIED",
        synthetic: true,
        decided_by: "ui_approval",
      },
    };
    this.emit(event);
    return pending;
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, RunSession>();

  constructor(private readonly factory: (caseId: string) => RunSession | null) {}

  /** Returns the existing session for a case, or creates one if the factory can. */
  getOrCreate(caseId: string): RunSession | null {
    const existing = this.sessions.get(caseId);
    if (existing) return existing;
    const session = this.factory(caseId);
    if (!session) return null;
    this.sessions.set(caseId, session);
    return session;
  }

  get(caseId: string): RunSession | undefined {
    return this.sessions.get(caseId);
  }

  all(): RunSession[] {
    return [...this.sessions.values()];
  }
}

/**
 * A `RunSession` over a live agent run: delegates to a `LiveFeed` (the
 * `LiveRunSource`) instead of a recorded array, so the server routes can
 * drive a real investigation through exactly the same path they use for
 * fixture replay. Pending approvals are derived by scanning the emitted
 * stream; `resolveApproval` feeds a synthetic `action_result` back into the
 * live feed, which broadcasts it exactly like an agent-emitted event.
 */
export class LiveSession implements RunSession {
  readonly case_id: string;

  constructor(
    private readonly feed: LiveFeed,
    caseId: string,
  ) {
    this.case_id = caseId;
  }

  getStatus(): SessionStatus {
    return this.feed.getStatus(this.case_id);
  }

  getEmittedEvents(): AgentEvent[] {
    return this.feed.getEvents(this.case_id);
  }

  getAnswer(): AnswerFile | null {
    return this.feed.getRecording(this.case_id)?.answer ?? null;
  }

  getPendingApprovals(): PendingApproval[] {
    const pending = new Map<string, PendingApproval>();
    for (const event of this.feed.getEvents(this.case_id)) {
      if (event.type === "approval_requested") {
        const action = String(event.payload["action"] ?? "unknown");
        pending.set(action, {
          seq: event.seq,
          case_id: this.case_id,
          action,
          route: String(event.payload["route"] ?? "unknown"),
          reason: String(event.payload["reason"] ?? ""),
          ts: event.ts,
        });
      } else if (event.type === "action_result") {
        pending.delete(String(event.payload["action"] ?? "unknown"));
      }
    }
    return [...pending.values()];
  }

  start(): void {
    this.feed.start(this.case_id);
  }

  subscribe(send: Subscriber): () => void {
    return this.feed.subscribe(this.case_id, send);
  }

  /** Approve/reject an L1/L2 action awaiting a human — feeds a synthetic `action_result` into the live stream. */
  resolveApproval(action: string, decision: "approved" | "rejected"): PendingApproval | null {
    const pending = this.getPendingApprovals().find((p) => p.action === action);
    if (!pending) return null;
    const events = this.feed.getEvents(this.case_id);
    const lastState = events.at(-1)?.state ?? "APPROVAL_ROUTING";
    this.feed.pushExternalEvent(this.case_id, {
      ts: new Date().toISOString(),
      type: "action_result",
      state: lastState,
      payload: {
        action,
        result: decision === "approved" ? "EXECUTED" : "DENIED",
        synthetic: true,
        decided_by: "ui_approval",
      },
    });
    return pending;
  }
}
