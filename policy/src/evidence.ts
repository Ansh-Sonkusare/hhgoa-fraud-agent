import { createHash } from "node:crypto";
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

function deterministicBit(seedParts: string[]): 0 | 1 {
  const hash = createHash("sha256").update(seedParts.join("|")).digest();
  // why: a single low-order bit is enough to alternate between two
  // documented, equally-plausible outcomes per (case, target, type) —
  // no `any`, just picking a bit out of a Buffer.
  return (hash[0]! & 1) as 0 | 1;
}

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

function scriptCustomerValidation(bit: 0 | 1): ScriptedOutcome {
  return bit === 0
    ? {
        responded: true,
        response_text:
          "Customer states they did not make these purchases and still has the card in their possession.",
        supports: ["fraud"],
        contradicts: ["legitimate"],
        weight_hint: 0.75,
      }
    : {
        responded: true,
        response_text: "Customer confirms they made this purchase themselves.",
        supports: ["legitimate"],
        contradicts: ["fraud"],
        weight_hint: 0.7,
      };
}

function scriptStepUpAuth(bit: 0 | 1): ScriptedOutcome {
  return bit === 0
    ? {
        responded: true,
        response_text:
          "Step-up authentication (one-time passcode) was not completed within the response window.",
        supports: ["fraud"],
        contradicts: ["legitimate"],
        weight_hint: 0.55,
      }
    : {
        responded: true,
        response_text: "Step-up authentication completed successfully by the cardholder.",
        supports: ["legitimate"],
        contradicts: ["fraud"],
        weight_hint: 0.6,
      };
}

function scriptAnalystInfo(bit: 0 | 1): ScriptedOutcome {
  return bit === 0
    ? {
        responded: true,
        response_text:
          "Analyst notes this device profile / region cluster has been flagged on other accounts before.",
        supports: ["fraud"],
        contradicts: [],
        weight_hint: 0.45,
      }
    : {
        responded: true,
        response_text: "Analyst has no additional signal beyond what the graph already shows.",
        supports: [],
        contradicts: [],
        weight_hint: 0.2,
      };
}

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
    const bit = deterministicBit([request.type, request.target.type, request.target.id, request.reason]);
    let outcome: ScriptedOutcome;
    switch (request.type) {
      case "customer_validation":
        outcome = scriptCustomerValidation(bit);
        break;
      case "step_up_auth":
        outcome = scriptStepUpAuth(bit);
        break;
      case "analyst_info":
        outcome = scriptAnalystInfo(bit);
        break;
      default: {
        // Exhaustiveness guard — EvidenceRequestType is a closed zod enum;
        // this branch only fires if the contract enum grows without this
        // switch being updated, which we want to fail loudly, not silently.
        const exhaustive: never = request.type;
        throw new Error(`SimulatedResponder: unhandled evidence request type ${String(exhaustive)}`);
      }
    }
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
