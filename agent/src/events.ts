import {
  AgentEventSchema,
  type AgentEvent,
  type AgentEventType,
  type AgentState,
} from "@hhgoa/contracts";

/**
 * Sequenced event log for one case run (PRD §8.5). Every event is validated
 * against the frozen `AgentEventSchema` at emission time, so a malformed
 * payload fails loudly in the machine run rather than silently reaching the
 * SSE stream / answer file later.
 */
export class EventLog {
  private readonly buffer: AgentEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: AgentEvent) => void>();

  constructor(private readonly caseId: string) {}

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(event: AgentEvent): AgentEvent {
    const parsed = AgentEventSchema.parse(event);
    this.buffer.push(parsed);
    for (const fn of this.listeners) fn(parsed);
    return parsed;
  }

  emit(type: AgentEventType, state: AgentState, payload: Record<string, unknown>): AgentEvent {
    return this.push({
      seq: this.seq++,
      ts: new Date().toISOString(),
      case_id: this.caseId,
      type,
      state,
      payload,
    });
  }

  list(): AgentEvent[] {
    return [...this.buffer];
  }

  count(type: AgentEventType): number {
    return this.buffer.filter((e) => e.type === type).length;
  }
}