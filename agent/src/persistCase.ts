import type { PersistCaseRequest, PersistCaseResult } from "./machine.js";
import type { McpClient } from "./mcpClient.js";
import type { RagRuntime } from "@hhgoa/rag";

/**
 * WS7 real write-back ("your agent should also write the case into the
 * graph", README Answer Format).
 *
 * Two disjoint writes, both of which must land for the machine to report
 * `written_to_graph: true`:
 *
 *   1. Graph vertices via the installed `upsert_case_record` GSQL query
 *      (gsql/queries/upsert_case_record.gsql): one call for the FraudCase
 *      vertex + its ABOUT edges to Card/Customer/Txn, then one call per
 *      child artifact (Finding / ActionRecord / Decision / EvidenceItem with
 *      its HAS_* edge). That TigerGraph CE build has no parse_json in
 *      queries (verified empirically), so children are written one call at a
 *      time rather than as a JSON array.
 *   2. Case memory into WS3's retrievable store (writeCaseToMemory), so a
 *      later investigation can retrieve this case via retrieve_similar_cases
 *      at any as_of ≥ this run's (PRD §8.1, §11).
 *
 * This function is deliberately total: any failure marks the write NOT
 * successful (ok:false, empty graph_case_id) so the answer's
 * `written_to_graph` stays honest. Persisting is a real-backend-only
 * operation — `FakeMcpClient.runInstalledQuery` throws, and runAgent never
 * wires persistCase under the fake backend.
 */
export async function persistCaseToGraph(
  mcp: McpClient,
  rag: RagRuntime,
  request: PersistCaseRequest,
): Promise<PersistCaseResult> {
  const graphId = request.graphCaseId || `GRAPH-${request.case_id}`;
  const base: Record<string, unknown> = {
    p_case_id: graphId,
    p_status: request.caseRecord.status,
    p_verdict: request.caseRecord.verdict,
    p_fraud_probability: request.caseRecord.fraud_probability,
    p_pattern: request.caseRecord.pattern,
    p_pattern_description: request.caseRecord.pattern_description,
    p_exposure_usd: request.caseRecord.exposure_usd,
    p_opened_at: request.opened_at,
    p_closed_at: request.closed_at,
    p_outcome: request.caseRecord.verdict,
    p_summary: request.caseRecord.summary,
    p_source: "live",
    p_report_filed: request.sarFiled,
    p_analyst_notes: request.caseRecord.summary,
    p_first_fraud_txn_id: request.caseRecord.first_suspicious_txn_id,
    p_n_txns: request.caseRecord.affected_txn_ids.length,
    p_card_id: request.card_id,
    p_customer_id: request.customer_id,
    p_txn_id: request.txn_id,
    p_item_id: "",
    p_item_category: "",
    p_item_text: "",
    p_item_score: 0,
    p_item_ts: request.closed_at,
    p_kind: "",
  };

  try {
    // 1. FraudCase vertex + ABOUT edges (idempotent DELETE+INSERT).
    await mcp.runInstalledQuery("upsert_case_record", base);

    // 2. Child artifacts, one call each (see header comment).
    const children: Promise<unknown>[] = [
      ...request.findings.map((f) =>
        mcp.runInstalledQuery("upsert_case_record", {
          ...base,
          p_kind: "finding",
          p_item_id: f.id,
          p_item_category: f.category,
          p_item_text: f.summary,
          p_item_score: f.weight_hint,
          p_item_ts: f.ts,
        }),
      ),
      ...request.actions.map((a) =>
        mcp.runInstalledQuery("upsert_case_record", {
          ...base,
          p_kind: "action",
          p_item_id: `${graphId}:action:${a.action}`,
          p_item_category: a.action,
          p_item_text: a.reason,
          p_item_score: 0,
          p_item_ts: request.closed_at,
        }),
      ),
      mcp.runInstalledQuery("upsert_case_record", {
        ...base,
        p_kind: "decision",
        p_item_id: `${graphId}:decision:final`,
        p_item_category: "agent",
        p_item_text: request.caseRecord.verdict,
        p_item_score: 0,
        p_item_ts: request.closed_at,
      }),
      ...request.findings.map((f) =>
        mcp.runInstalledQuery("upsert_case_record", {
          ...base,
          p_kind: "evidence",
          p_item_id: `${f.id}:evidence`,
          p_item_category: f.category,
          p_item_text: f.summary,
          p_source: f.source_tool,
          p_item_score: f.weight_hint,
          p_item_ts: f.ts,
        }),
      ),
    ];
    await Promise.all(children);

    // 3. Retrievable case memory (WS3 write path).
    await rag.writeCaseToMemory({
      case_id: request.case_id,
      case_record: request.caseRecord,
      customer_id: request.customer_id,
      card_id: request.card_id,
      as_of: request.as_of,
    });

    return { ok: true, graph_case_id: graphId };
  } catch (err) {
    console.error(
      `[persistCase] write-back failed for case ${request.case_id}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, graph_case_id: "" };
  }
}