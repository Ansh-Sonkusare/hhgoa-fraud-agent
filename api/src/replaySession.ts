import type { AgentEvent } from "@hhgoa/contracts";
import type { RunRecording } from "./runSource.js";
import { env } from "./env.js";

export type SessionStatus = "idle" | "running" | "done";

export interface PendingApproval {
  seq: number;
  case_id: string;
  action: string;
  route: string;
  reason: string;
  ts: string;
}

type Subscriber = (event: AgentEvent) => void;

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
export class ReplaySession {
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

export class ReplaySessionRegistry {
  private readonly sessions = new Map<string, ReplaySession>();

  constructor(private readonly getRecording: (caseId: string) => RunRecording | null) {}

  /** Returns the existing session for a case, or creates one if a recording exists. */
  getOrCreate(caseId: string): ReplaySession | null {
    const existing = this.sessions.get(caseId);
    if (existing) return existing;
    const recording = this.getRecording(caseId);
    if (!recording) return null;
    const session = new ReplaySession(recording);
    this.sessions.set(caseId, session);
    return session;
  }

  get(caseId: string): ReplaySession | undefined {
    return this.sessions.get(caseId);
  }

  all(): ReplaySession[] {
    return [...this.sessions.values()];
  }
}
