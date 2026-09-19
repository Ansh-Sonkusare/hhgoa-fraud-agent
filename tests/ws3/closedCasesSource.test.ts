import { describe, expect, it } from "vitest";
import {
  loadCasePack,
  loadClosedCases,
} from "../../rag/src/sources/closedCases.js";
import { buildCaseSummaryText } from "../../rag/src/ingestCases.js";
import { parseCsv, parseCsvObjects, streamCsvObjects } from "../../rag/src/sources/csv.js";

describe("csv parser", () => {
  it("parses quoted fields with embedded commas and escaped quotes", () => {
    const csv = 'a,b,c\n"x, y","say ""hi""",z\n';
    const rows = parseCsv(csv);
    expect(rows[1]).toEqual(["x, y", 'say "hi"', "z"]);
  });

  it("parseCsvObjects keys rows by header", () => {
    const objs = parseCsvObjects("h1,h2\n1,2\n3,4");
    expect(objs).toEqual([
      { h1: "1", h2: "2" },
      { h1: "3", h2: "4" },
    ]);
  });

  it("streamCsvObjects yields the same rows as parseCsvObjects", async () => {
    const csv = "h1,h2\na,b\n\"c,d\",e\n";
    const fromStream: Record<string, string>[] = [];
    const tmp = "/tmp/opencode/ws3-stream.csv";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmp, csv, "utf-8");
    for await (const row of streamCsvObjects(tmp)) fromStream.push(row);
    expect(fromStream).toEqual(parseCsvObjects(csv));
  });
});

describe("closed_cases_history.csv", () => {
  const cases = loadClosedCases();

  it("loads all 5,565 rows with the documented columns", () => {
    expect(cases.length).toBe(5565);
    const row = cases[0]!;
    expect(row.case_id).toBe("CC-0001");
    expect(row.outcome).toBe("confirmed_fraud");
    expect(row.pattern).toBe("card_not_present_fraud");
    expect(typeof row.exposure_usd).toBe("number");
    expect(Array.isArray(row.txn_ids)).toBe(true);
    expect(Array.isArray(row.connected_card_ids)).toBe(true);
    expect(Array.isArray(row.actions_taken)).toBe(true);
    expect(row.analyst_notes.length).toBeGreaterThan(50);
  });

  it("counts match the dataset README (4,665 confirmed, 900 cleared)", () => {
    const confirmed = cases.filter((c) => c.outcome === "confirmed_fraud").length;
    const cleared = cases.filter((c) => c.outcome === "cleared").length;
    expect(confirmed).toBe(4665);
    expect(cleared).toBe(900);
  });

  it("parses report_filed Yes/No and pipe-separated lists", () => {
    const filed = cases.find((c) => c.report_filed);
    expect(filed).toBeDefined();
    for (const c of cases) expect(typeof c.report_filed).toBe("boolean");
  });
});

describe("case_pack.csv", () => {
  const pack = loadCasePack();

  it("loads exactly 20 benchmark cases", () => {
    expect(pack.length).toBe(20);
    expect(pack[0]!.case_id).toBe("HHG-001");
  });

  it("carries trigger types, ids and (nullable) risk scores", () => {
    for (const c of pack) {
      expect(["risk_score", "customer_report", "analyst_request"]).toContain(c.trigger_type);
      expect(c.customer_id).toMatch(/^C\d+/);
      expect(c.flagged_txn_id.length).toBeGreaterThan(0);
    }
    const risk = pack.find((c) => c.trigger_type === "risk_score")!;
    expect(typeof risk.risk_score).toBe("number");
    const report = pack.find((c) => c.trigger_type === "customer_report")!;
    expect(report.risk_score).toBeNull();
  });
});

describe("buildCaseSummaryText", () => {
  it("uses the analyst narrative as the embedded summary", () => {
    const [row] = loadClosedCases();
    expect(buildCaseSummaryText(row!)).toBe(row!.analyst_notes);
  });
});