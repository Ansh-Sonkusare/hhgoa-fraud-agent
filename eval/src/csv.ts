import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** Split one CSV line into fields, honoring double-quoted cells (incl. embedded commas). */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

/** Streams a CSV line-by-line. Required for the ~700MB transactions table. */
export function readCsvLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    rl.on("line", onLine);
    rl.once("error", reject);
    rl.once("close", resolve);
  });
}

export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

/**
 * Reads a CSV file into header-keyed rows. Values stay strings; callers
 * coerce. Underscores in headers are kept verbatim (data uses snake_case).
 */
export function readCsv(filePath: string): ParsedCsv {
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find((l) => l.trim().length > 0);
  if (!headerLine) return { headers: [], rows: [] };
  const headers = splitCsvLine(headerLine);
  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    const row: CsvRow = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (header === undefined) continue;
      row[header] = cells[i] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

/** Reads one column of a CSV by name, streaming the file (see transaction table scale). */
export async function readCsvColumnAsync(filePath: string, header: string): Promise<string[]> {
  const out: string[] = [];
  let col = -1;
  let headerError: string | null = null;
  await readCsvLines(filePath, (rawLine) => {
    const line = rawLine.replace(/^\uFEFF/, "");
    if (line.trim() === "") return;
    if (col === -1) {
      const headers = splitCsvLine(line);
      col = headers.indexOf(header);
      if (col === -1) headerError = `readCsvColumnAsync: header "${header}" not found in ${filePath}`;
      return;
    }
    const v = splitCsvLine(line)[col];
    if (v !== undefined && v !== "") out.push(v);
  });
  if (headerError) throw new Error(headerError);
  return out;
}