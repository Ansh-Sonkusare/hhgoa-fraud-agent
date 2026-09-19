import { createReadStream } from "node:fs";

/**
 * Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines,
 * `""`-escaped quotes). No external dependency — the only quoting we
 * actually hit in this dataset is `closed_cases_history.csv`'s
 * `analyst_notes` (free text with commas) and `case_pack.csv`'s
 * `trigger_text`, but a real state machine costs little and is safer than
 * a `.split(",")` that would silently corrupt any row with a comma in a
 * note.
 */
class CsvRowAssembler {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private sawAnyChar = false;

  feed(chunk: string, onRow: (row: string[]) => void): void {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      this.sawAnyChar = true;
      if (this.inQuotes) {
        if (c === '"') {
          if (chunk[i + 1] === '"') {
            this.field += '"';
            i++;
          } else {
            this.inQuotes = false;
          }
        } else {
          this.field += c;
        }
        continue;
      }
      if (c === '"') {
        this.inQuotes = true;
      } else if (c === ",") {
        this.row.push(this.field);
        this.field = "";
      } else if (c === "\r") {
        // swallow; \n (or EOF) ends the record
      } else if (c === "\n") {
        this.row.push(this.field);
        onRow(this.row);
        this.row = [];
        this.field = "";
      } else {
        this.field += c;
      }
    }
  }

  end(onRow: (row: string[]) => void): void {
    if (this.field.length > 0 || this.row.length > 0 || this.sawAnyChar) {
      this.row.push(this.field);
      // Don't emit a final all-empty single-field row from a trailing newline.
      if (!(this.row.length === 1 && this.row[0] === "" && this.field === "")) {
        onRow(this.row);
      }
    }
  }
}

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  const assembler = new CsvRowAssembler();
  assembler.feed(content, (r) => rows.push(r));
  assembler.end((r) => rows.push(r));
  // Drop a genuinely empty trailing row (file ending in \n\n or similar).
  while (rows.length > 0 && rows[rows.length - 1]!.every((f) => f === "")) {
    rows.pop();
  }
  return rows;
}

/** Parse header + rows into objects keyed by header name. */
export function parseCsvObjects(content: string): Record<string, string>[] {
  const rows = parseCsv(content);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    return obj;
  });
}

/**
 * Stream a large CSV (e.g. `transactions.csv`, 708MB / ~590k rows) without
 * loading it fully into memory. Yields each row as a header-keyed object.
 * Used by `transactionSignals.ts` to pull device/address columns for only
 * the handful of `TransactionID`s a fingerprint needs, in one pass.
 */
export async function* streamCsvObjects(
  filePath: string,
): AsyncGenerator<Record<string, string>, void, unknown> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const assembler = new CsvRowAssembler();
  let header: string[] | null = null;
  let pendingRows: string[][] = [];

  const onRow = (row: string[]) => {
    if (!header) {
      header = row;
    } else {
      pendingRows.push(row);
    }
  };

  for await (const chunk of stream) {
    assembler.feed(chunk as string, onRow);
    if (pendingRows.length > 0) {
      const h = header!;
      for (const row of pendingRows) {
        const obj: Record<string, string> = {};
        h.forEach((name, i) => {
          obj[name] = row[i] ?? "";
        });
        yield obj;
      }
      pendingRows = [];
    }
  }
  assembler.end(onRow);
  if (pendingRows.length > 0 && header) {
    const h = header as string[];
    for (const row of pendingRows) {
      const obj: Record<string, string> = {};
      h.forEach((name, i) => {
        obj[name] = row[i] ?? "";
      });
      yield obj;
    }
  }
}
