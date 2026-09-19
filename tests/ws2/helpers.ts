/**
 * Test helpers for tests/ws2.
 *
 * These tests run against the LIVE TigerGraph container over REST
 * (:9000), not fakes -- gsql/ has no in-process business logic to unit
 * test, only installed queries. `gsql/install.ts` must have been run
 * first (`pnpm --filter @hhgoa/gsql install-queries`, or `make
 * verify-gsql` which does both). Assertions target structural/as_of
 * behavior against real dataset ids documented in docs/decisions.md and
 * docs/logs.md, not a fixed benchmark outcome (no case-pack-answer
 * leakage into tests).
 */
const HOST = process.env.TIGERGRAPH_REST_HOST ?? "localhost";
const PORT = process.env.TIGERGRAPH_REST_PORT ?? "9000";
const USER = process.env.TIGERGRAPH_USERNAME ?? "tigergraph";
const PASS = process.env.TIGERGRAPH_PASSWORD ?? "tigergraph";
const GRAPH = "hhgoa_fraud";

export interface QueryResponse<T> {
  error: boolean;
  message: string;
  results: T[];
}

/**
 * POST params as the raw JSON body (NOT wrapped in {"params": ...}) --
 * this is the REST shape pyTigerGraph's runInstalledQuery uses and the one
 * confirmed working against this build (see docs/decisions.md /
 * docs/logs.md). `as_of` must be "YYYY-MM-DD HH:MM:SS".
 */
export async function runQuery<T = Record<string, unknown>>(
  queryName: string,
  params: Record<string, unknown>,
): Promise<T> {
  const auth = Buffer.from(`${USER}:${PASS}`).toString("base64");
  const res = await fetch(`http://${HOST}:${PORT}/query/${GRAPH}/${queryName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as QueryResponse<T>;
  if (body.error) {
    throw new Error(`runQuery(${queryName}) failed: ${body.message}`);
  }
  return body.results[0] as T;
}

// Real ids used throughout tests/ws2, all documented in docs/decisions.md /
// docs/logs.md ground truth (verified against graph/build/*.csv and live
// query output during WS2 development -- not fixture/benchmark-answer data).
export const KNOWN = {
  // txn 3514030: ts 2016-12-04 19:55:28, $77.07, in_person, risk 0.61,
  // MADE on card C21139-K1 (customer C12382) -- the case-pack HHG-001
  // references card C12382-K1, a different (stub) id for the same customer.
  txnId: "3514030",
  txnCardId: "C21139-K1",
  txnCustomerId: "C12382",
  txnTs: "2016-12-04 19:55:28",
  asOfAfterTxn: "2016-12-05 01:55:28",
  asOfBeforeTxn: "2016-12-01 00:00:00",
  // Before the card's first-ever transaction (its full history starts
  // 2016-07-06 per get_entity_profile) -- distinct from asOfBeforeTxn,
  // which is before the *known* txn but after the card's history begins.
  asOfBeforeAnyHistory: "2015-01-01 00:00:00",

  // Closed case CC-0001: references stub card C00259-K1, but its
  // first-fraud txn 3000120 is on real card C15620-K1 (customer C00259).
  stubCardId: "C00259-K1",
  realCardForStub: "C15620-K1",
  customerForStub: "C00259",
  caseIdForStub: "CC-0001",

  lateAsOf: "2016-12-31 23:59:59",
};
