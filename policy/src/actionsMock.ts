import type { PolicyActionName, ExecuteActionParams } from "./types.js";

/**
 * Mock action APIs (PRD §10.4): "freeze, block, message, CRM update" — write
 * an action log, no real side effects. Covers all 14 action identifiers
 * from README Fraud Policy §1. The `Record<PolicyActionName, ...>` type
 * forces this object to stay exhaustive: adding an action to the contract
 * enum without a description here is a compile error.
 */
const EFFECT_DESCRIPTIONS: Record<PolicyActionName, (params: ExecuteActionParams) => string> = {
  ALLOW_TRANSACTION: () => "Flagged transaction allowed to stand.",
  DECLINE_TRANSACTION: () => "Flagged authorization declined; card remains active.",
  MONITOR_CARD: () => "Card monitoring sensitivity raised for 72 hours.",
  MONITOR_CONNECTED_CARDS: () =>
    "Other cards sharing the flagged device profile / region cluster / ring placed under monitoring.",
  WARN_CUSTOMER: () => "Informational message sent to the customer.",
  VERIFY_WITH_CUSTOMER: () =>
    "Verification request sent to the cardholder; card stays active pending reply.",
  STEP_UP_AUTH: () => "Step-up authentication (one-time passcode / app confirmation) required.",
  BLOCK_CARD: () => "Card blocked and scheduled for reissue.",
  BLOCK_ALL_CARDS: () => "Every card held by the customer blocked.",
  GENERATE_REPORT: () => "Investigation write-up generated for the internal record; no case opened.",
  CREATE_CASE: () => "Internal fraud case opened with evidence attached and written to the graph.",
  FILE_REPORT: () => "Suspicious activity report filed with the regulator.",
  ESCALATE_TO_ANALYST: () => "Case handed to a human fraud analyst with the evidence.",
  CLOSE_NO_FRAUD: () => "Alert closed as legitimate.",
};

export interface ActionLogEntry {
  action: PolicyActionName;
  case_id: string;
  reason: string;
  effect: string;
  ts: string;
}

export interface ActionsMock {
  run(action: PolicyActionName, params: ExecuteActionParams): Promise<ActionLogEntry>;
  getLog(): ActionLogEntry[];
}

/** In-memory, side-effect-free action executor. One instance per case run. */
export class InMemoryActionsMock implements ActionsMock {
  private readonly log: ActionLogEntry[] = [];

  async run(action: PolicyActionName, params: ExecuteActionParams): Promise<ActionLogEntry> {
    const describe = EFFECT_DESCRIPTIONS[action];
    const entry: ActionLogEntry = {
      action,
      case_id: params.case_state.case_id,
      reason: params.reason,
      effect: describe(params),
      ts: new Date().toISOString(),
    };
    this.log.push(entry);
    return entry;
  }

  getLog(): ActionLogEntry[] {
    return [...this.log];
  }
}

export const ALL_ACTION_NAMES = Object.keys(EFFECT_DESCRIPTIONS) as PolicyActionName[];
