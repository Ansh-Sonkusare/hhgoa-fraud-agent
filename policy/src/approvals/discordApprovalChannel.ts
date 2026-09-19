import type { ApprovalChannel, PolicyActionName, ApprovalRoute } from "@hhgoa/contracts";
import { UIApprovalChannel } from "./uiApprovalChannel.js";

/**
 * Optional Discord approval channel (PRD §10.4: "optional, never on the
 * critical path"). Posts a webhook message when an approval is requested;
 * reply capture (a human clicking approve/reject in Discord, or a Hermes
 * gateway relaying it back) is NOT implemented here — that requires an
 * inbound webhook/bot listener, which is out of scope for this session and
 * would need infra WS4/WS5 don't own. See docs/REQUESTS.md.
 *
 * Decisions still resolve through the same `UIApprovalChannel` table this
 * class wraps, so `resolve()` (called by whatever eventually captures the
 * Discord reply) has the same effect as a UI approval. If no webhook URL is
 * configured, this degrades to a plain `UIApprovalChannel` with no network
 * call — never blocks the run.
 */
export class DiscordApprovalChannel implements ApprovalChannel {
  private readonly inner = new UIApprovalChannel();

  constructor(private readonly webhookUrl: string | undefined) {}

  async requestApproval(input: {
    case_id: string;
    action: PolicyActionName;
    route: ApprovalRoute;
    reason: string;
  }): Promise<"approved" | "rejected" | "pending"> {
    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: `Approval requested: case ${input.case_id} — ${input.action} (route ${input.route}). Reason: ${input.reason}`,
          }),
        });
      } catch {
        // Never let a Discord posting failure block the agent — approvals
        // still work through resolve()/the UI channel underneath.
      }
    }
    return this.inner.requestApproval(input);
  }

  resolve(case_id: string, action: PolicyActionName, decision: "approved" | "rejected"): void {
    this.inner.resolve(case_id, action, decision);
  }
}
