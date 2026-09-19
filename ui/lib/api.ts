import type { AgentEvent } from "@hhgoa/contracts";
import type { CaseDetail, CaseListItem, PendingApproval } from "./types";

// Same-origin, proxied to API_BASE_URL by next.config.mjs's rewrite —
// see the comment there for why.
const BACKEND = "/backend";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`POST ${path} -> ${res.status}: ${errBody}`);
  }
  return (await res.json()) as T;
}

export function fetchCases(): Promise<CaseListItem[]> {
  return getJson<{ cases: CaseListItem[] }>("/api/cases").then((r) => r.cases);
}

export function fetchCaseDetail(caseId: string): Promise<CaseDetail> {
  return getJson<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`);
}

export function fetchApprovals(): Promise<PendingApproval[]> {
  return getJson<{ pending: PendingApproval[] }>("/api/approvals").then((r) => r.pending);
}

export function postNewTrigger(trigger: unknown): Promise<{ case_id: string; note: string }> {
  return postJson("/api/cases", { trigger });
}

export function postApprovalDecision(
  caseId: string,
  action: string,
  decision: "approved" | "rejected",
): Promise<{ ok: true }> {
  return postJson(
    `/api/cases/${encodeURIComponent(caseId)}/approvals/${encodeURIComponent(action)}/decision`,
    { decision },
  );
}

/**
 * Opens the live investigation timeline SSE stream (PRD §14). Client-only
 * (EventSource doesn't exist server-side). Returns an unsubscribe function.
 */
export function subscribeToCaseEvents(
  caseId: string,
  onEvent: (event: AgentEvent) => void,
  onStreamDone: () => void,
  onError: (message: string) => void,
): () => void {
  const source = new EventSource(`${BACKEND}/api/cases/${encodeURIComponent(caseId)}/events`);

  // Whether the stream has already announced DONE. The server stays open
  // after DONE so later human decisions (synthetic action_result broadcasts)
  // still arrive, but it may also close the stream right after DONE (a late
  // joiner to an already-finished run gets the full backlog replayed, then
  // the server closes). Either way, once we've seen stream_done a subsequent
  // connection-close is the normal end, not an error.
  let sawStreamDone = false;

  source.addEventListener("agent_event", (e) => {
    try {
      onEvent(JSON.parse((e as MessageEvent).data) as AgentEvent);
    } catch {
      onError("Received a malformed event from the server.");
    }
  });
  source.addEventListener("stream_done", () => {
    sawStreamDone = true;
    onStreamDone();
  });
  source.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data;
    if (typeof data === "string") {
      try {
        onError((JSON.parse(data) as { message?: string }).message ?? "Stream error.");
        return;
      } catch {
        // fall through to generic message below
      }
    }
    // EventSource itself also fires a plain "error" event on network hiccups
    // and when the connection closes. Closing after stream_done is normal
    // (see sawStreamDone); anything else that actually closed the connection
    // is worth surfacing.
    if (source.readyState === EventSource.CLOSED && !sawStreamDone) {
      onError("Connection to the investigation stream closed.");
    }
  });

  return () => source.close();
}
