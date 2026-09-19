/**
 * The 20 benchmark cases, transcribed verbatim from the "The 20 Cases" table
 * in the dataset README.md (repo root). That table IS `case_pack.csv` — the
 * README says so explicitly ("Also available as case_pack.csv in this
 * folder"). `data/` (which would hold the real CSV) is gitignored raw
 * dataset per CLAUDE.md, so this file is the case queue's source of truth
 * for WS6 until a real API/DB exists. Do not edit trigger text/ids here
 * without re-checking README.md — this must stay byte-identical to it.
 */

export type TriggerType = "risk_score" | "customer_report" | "analyst_request";

export interface CasePackEntry {
  case_id: string;
  opened_at: string;
  trigger_type: TriggerType;
  flagged_txn_id: string;
  card_id: string;
  customer_id: string;
  /** null for trigger types other than risk_score (README uses "—") */
  risk_score: number | null;
  trigger_text: string;
}

export const CASE_PACK: CasePackEntry[] = [
  {
    case_id: "HHG-001",
    opened_at: "2016-12-05T01:55:28Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3514030",
    card_id: "C12382-K1",
    customer_id: "C12382",
    risk_score: 0.61,
    trigger_text:
      "Real-time model scored transaction 3514030 ($77.07, in billing region 444.0) at 0.61. Review and decide.",
  },
  {
    case_id: "HHG-002",
    opened_at: "2016-11-22T23:27:07Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3478782",
    card_id: "C11891-K1",
    customer_id: "C11891",
    risk_score: 0.79,
    trigger_text:
      "Real-time model scored transaction 3478782 ($292.36, online) at 0.79. Review and decide.",
  },
  {
    case_id: "HHG-003",
    opened_at: "2016-12-10T15:01:21Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3530164",
    card_id: "C08623-K2",
    customer_id: "C08623",
    risk_score: null,
    trigger_text:
      "Customer C08623 message: 'I never made this $49.00 purchase. Please check my card.' Refers to 3530164.",
  },
  {
    case_id: "HHG-004",
    opened_at: "2016-12-29T07:53:54Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3583227",
    card_id: "C08106-K1",
    customer_id: "C08106",
    risk_score: null,
    trigger_text:
      "Customer C08106 message: 'I never made this $128.33 purchase. Please check my card.' Refers to 3583227.",
  },
  {
    case_id: "HHG-005",
    opened_at: "2016-12-08T03:38:37Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3523199",
    card_id: "C02923-K1",
    customer_id: "C02923",
    risk_score: 0.54,
    trigger_text:
      "Real-time model scored transaction 3523199 ($100.07, online) at 0.54. Review and decide.",
  },
  {
    case_id: "HHG-006",
    opened_at: "2016-11-22T02:30:00Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3476682",
    card_id: "C07297-K1",
    customer_id: "C07297",
    risk_score: null,
    trigger_text:
      "Customer C07297 message: 'I never made this $482.12 purchase. Please check my card.' Refers to 3476682.",
  },
  {
    case_id: "HHG-007",
    opened_at: "2016-12-05T03:46:14Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3514948",
    card_id: "C09933-K2",
    customer_id: "C09933",
    risk_score: 0.87,
    trigger_text:
      "Real-time model scored transaction 3514948 ($111.92, in billing region 264.0) at 0.87. Review and decide.",
  },
  {
    case_id: "HHG-008",
    opened_at: "2016-12-20T03:08:56Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3558054",
    card_id: "C13171-K2",
    customer_id: "C13171",
    risk_score: null,
    trigger_text:
      "Customer C13171 message: 'I never made this $55.68 purchase. Please check my card.' Refers to 3558054.",
  },
  {
    case_id: "HHG-009",
    opened_at: "2016-12-28T17:10:53Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3581141",
    card_id: "C08299-K1",
    customer_id: "C08299",
    risk_score: null,
    trigger_text:
      "Customer C08299 message: 'I never made this $30.02 purchase. Please check my card.' Refers to 3581141.",
  },
  {
    case_id: "HHG-010",
    opened_at: "2016-12-02T18:18:27Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3506725",
    card_id: "C10434-K1",
    customer_id: "C10434",
    risk_score: 0.9,
    trigger_text:
      "Real-time model scored transaction 3506725 ($1,000.03, online) at 0.90. Review and decide.",
  },
  {
    case_id: "HHG-011",
    opened_at: "2016-12-29T06:27:44Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3583368",
    card_id: "C11923-K2",
    customer_id: "C11923",
    risk_score: null,
    trigger_text:
      "Customer C11923 message: 'I never made this $131.30 purchase. Please check my card.' Refers to 3583368.",
  },
  {
    case_id: "HHG-012",
    opened_at: "2016-12-18T05:00:31Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3553342",
    card_id: "C05876-K2",
    customer_id: "C05876",
    risk_score: 0.55,
    trigger_text:
      "Real-time model scored transaction 3553342 ($30.91, in billing region 494.0) at 0.55. Review and decide.",
  },
  {
    case_id: "HHG-013",
    opened_at: "2016-12-09T05:39:29Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3526826",
    card_id: "C07671-K2",
    customer_id: "C07671",
    risk_score: 0.76,
    trigger_text:
      "Real-time model scored transaction 3526826 ($35.66, online) at 0.76. Review and decide.",
  },
  {
    case_id: "HHG-014",
    opened_at: "2016-11-22T20:11:00Z",
    trigger_type: "analyst_request",
    flagged_txn_id: "3478561",
    card_id: "C13487-K1",
    customer_id: "C13487",
    risk_score: null,
    trigger_text:
      "Analyst request: several cards this month show purchases from the same unusual device profile. Review transaction 3478561 on card C13487-K1 and look for related activity.",
  },
  {
    case_id: "HHG-015",
    opened_at: "2016-11-17T19:03:36Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3464869",
    card_id: "C03042-K1",
    customer_id: "C03042",
    risk_score: 0.77,
    trigger_text:
      "Real-time model scored transaction 3464869 ($599.94, online) at 0.77. Review and decide.",
  },
  {
    case_id: "HHG-016",
    opened_at: "2016-12-12T01:39:08Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3534820",
    card_id: "C09988-K1",
    customer_id: "C09988",
    risk_score: null,
    trigger_text:
      "Customer C09988 message: 'I never made this $59.67 purchase. Please check my card.' Refers to 3534820.",
  },
  {
    case_id: "HHG-017",
    opened_at: "2016-11-12T00:46:24Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3450629",
    card_id: "C04570-K1",
    customer_id: "C04570",
    risk_score: 0.57,
    trigger_text:
      "Real-time model scored transaction 3450629 ($100.09, online) at 0.57. Review and decide.",
  },
  {
    case_id: "HHG-018",
    opened_at: "2016-11-27T14:41:26Z",
    trigger_type: "customer_report",
    flagged_txn_id: "3491361",
    card_id: "C02354-K2",
    customer_id: "C02354",
    risk_score: null,
    trigger_text:
      "Customer C02354 message: 'I never made this $39.08 purchase. Please check my card.' Refers to 3491361.",
  },
  {
    case_id: "HHG-019",
    opened_at: "2016-12-01T22:28:53Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3503878",
    card_id: "C07987-K2",
    customer_id: "C07987",
    risk_score: 0.9,
    trigger_text:
      "Real-time model scored transaction 3503878 ($99.92, online) at 0.90. Review and decide.",
  },
  {
    case_id: "HHG-020",
    opened_at: "2016-12-03T12:04:26Z",
    trigger_type: "risk_score",
    flagged_txn_id: "3509359",
    card_id: "C12265-K2",
    customer_id: "C12265",
    risk_score: 0.52,
    trigger_text:
      "Real-time model scored transaction 3509359 ($125.08, online) at 0.52. Review and decide.",
  },
];

export function findCasePackEntry(caseId: string): CasePackEntry | undefined {
  return CASE_PACK.find((c) => c.case_id === caseId);
}
