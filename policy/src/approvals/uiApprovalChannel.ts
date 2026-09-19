import type { ApprovalChannel, PolicyActionName, ApprovalRoute } from "@hhgoa/contracts";

/**
 * Default `ApprovalChannel` (PRD §10.4). There is no live UI in this
 * session (WS6's territory) so this channel cannot itself put a decision in
 * front of a human — it holds a decisions table that:
 *   - `requestApproval` reads from (returns "pending" if nothing recorded
 *     yet, which is what makes `execute_action` return PENDING_APPROVAL —
 *     PRD §10.5 hard guarantee 2),
 *   - `resolve()` writes to. The Fastify API (WS6) calls `resolve()` from
 *     its "Approve"/"Reject" endpoints; `tests/ws5` calls it directly to
 *     exercise the "UI approve -> EXECUTED" acceptance check (PRD §4.2 C8)
 *     without needing a live server.
 */
export class UIApprovalChannel implements ApprovalChannel {
  private readonly decisions = new Map<string, "approved" | "rejected">();

  private static key(case_id: string, action: PolicyActionName): string {
    return `${case_id}:${action}`;
  }

  async requestApproval(input: {
    case_id: string;
    action: PolicyActionName;
    route: ApprovalRoute;
    reason: string;
  }): Promise<"approved" | "rejected" | "pending"> {
    const existing = this.decisions.get(UIApprovalChannel.key(input.case_id, input.action));
    return existing ?? "pending";
  }

  /** Called by the API layer (or tests) once a human has decided. */
  resolve(case_id: string, action: PolicyActionName, decision: "approved" | "rejected"): void {
    this.decisions.set(UIApprovalChannel.key(case_id, action), decision);
  }

  /** For an approvals-inbox view: every decision recorded so far. */
  listDecisions(): Array<{ case_id: string; action: PolicyActionName; decision: "approved" | "rejected" }> {
    return [...this.decisions.entries()].map(([key, decision]) => {
      const [case_id, action] = key.split(":") as [string, PolicyActionName];
      return { case_id, action, decision };
    });
  }
}
