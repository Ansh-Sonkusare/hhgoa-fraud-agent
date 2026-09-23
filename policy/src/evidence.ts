import type {
  EvidenceResponder,
  EvidenceRequestInput,
  EvidenceResponse,
  EvidenceItem,
} from "@hhgoa/contracts";

/**
 * `EvidenceResponder` implementations (PRD §10.4, README Fraud Policy §5).
 *
 * README §5 is explicit: "In this round those responses are not provided.
 * Simulate them in your own system and state the assumption you made."
 * That means the responder must be:
 *   - deterministic and seeded (reproducible runs, PRD §15),
 *   - documented (this file *is* the documentation of the assumption),
 *   - NOT a function of any hidden fraud label — only of information the
 *     agent already legitimately has (case_id, the target entity id, and
 *     the request type). No `isFraud`-style field exists in this dataset
 *     (PRD OQ11) and none is threaded in here even hypothetically.
 */

let evidenceIdCounter = 0;
function nextEvidenceId(): string {
  evidenceIdCounter += 1;
  return `ev_resp_${String(evidenceIdCounter).padStart(4, "0")}`;
}

/** Test-only: reset the id counter so tests get predictable ids. */
export function resetEvidenceIdCounter(): void {
  evidenceIdCounter = 0;
}

interface ScriptedOutcome {
  responded: boolean;
  response_text: string;
  supports: string[];
  contradicts: string[];
  weight_hint: number;
}




/** What we record having assumed, per request type. No reply is invented. */
const NO_REPLY_TEXT: Record<EvidenceRequestInput["type"], string> = {
  customer_validation:
    "No cardholder reply was received within the investigation window; the dataset supplies none, and none was assumed.",
  step_up_auth:
    "Step-up authentication was requested; no outcome was returned within the investigation window, and none was assumed.",
  analyst_info:
    "Analyst information was requested; no analyst note was returned within the investigation window, and none was assumed.",
};

function buildEvidenceItem(
  request: EvidenceRequestInput,
  outcome: ScriptedOutcome,
): EvidenceItem {
  return {
    id: nextEvidenceId(),
    category: "customer_response",
    summary: outcome.response_text,
    entities: [{ type: request.target.type, id: request.target.id }],
    source_tool: "request_evidence",
    weight_hint: outcome.weight_hint,
    supports: outcome.supports,
    contradicts: outcome.contradicts,
    ts: new Date().toISOString(),
  };
}

/**
 * Deterministic, seeded, documented-assumption responder. This is the
 * default responder used in every benchmark run (README §5 requires
 * *some* simulation since live responses aren't provided).
 */
export class SimulatedResponder implements EvidenceResponder {
  async respond(request: EvidenceRequestInput): Promise<EvidenceResponse> {
    // README §5: cardholder and analyst replies "are not provided". The only
    // truthful thing we can report about an oracle we do not have is that no
    // reply came back. This used to invent one instead, choosing between two
    // plausible outcomes with a hash bit of the request fields. That was
    // deterministic, documented and label-free -- but it was still made up,
    // and being uncorrelated with the truth by construction it could only add
    // noise. It was decisive noise: in a 35-case backtest every confirmed-fraud
    // case that happened to draw "customer confirms" closed legitimate (6 of
    // 6), throwing away graph evidence that ran to 159 items on one of them.
    //
    // Asking is still real work and is still recorded in `evidence_requests`
    // (README's Answer Format requires the assumption we made), and policy rule
    // R1 is satisfied by *recommending* VERIFY_WITH_CUSTOMER / STEP_UP_AUTH --
    // which the agent still does. What we must not do is invent that action's
    // result and then reason over it. The item below carries no weight and
    // supports nothing, and the agent drops it rather than counting it as an
    // evidence category.
    const outcome: ScriptedOutcome = {
      responded: false,
      response_text: NO_REPLY_TEXT[request.type],
      supports: [],
      contradicts: [],
      weight_hint: 0,
    };
    return {
      request_type: request.type,
      responded: outcome.responded,
      response_text: outcome.response_text,
      evidence: buildEvidenceItem(request, outcome),
    };
  }
}

/**
 * If the dataset ever supplies real recorded responses to evidence
 * requests, this is where they'd be loaded and replayed keyed by
 * (case_id, request type). README does not provide such a table (§5: "not
 * provided" — the agent is told to simulate), so this stays a documented
 * stub rather than a real implementation; not wired into any run.
 */
export class DatasetResponder implements EvidenceResponder {
  respond(_request: EvidenceRequestInput): Promise<EvidenceResponse> {
    return Promise.reject(
      new Error(
        "DatasetResponder: README does not supply recorded evidence-request responses (§5) — use SimulatedResponder. See docs/REQUESTS.md if this changes.",
      ),
    );
  }
}
