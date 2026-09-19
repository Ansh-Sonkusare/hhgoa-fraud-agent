/**
 * graph/scripts/lib/csv.ts — WS1: minimal streaming RFC 4180 CSV reader so
 * the 708 MB transactions.csv can be consumed line-by-line without loading
 * it into memory, plus a small writer. Deliberately dependency-free; any
 * holes found while loading the real files get fixed here, not papered over.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

/** Read a CSV stream, invoking `onRecord` per parsed record (string[]). */
export async function eachRow(
  file: string,
  onRecord: (row: string[]) => void | Promise<void>,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let lineNo = 0;

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = async () => {
    pushField();
    await onRecord(record);
    record = [];
  };

  for await (const rawLine of rl) {
    lineNo += 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        pushField();
      } else {
        field += ch;
      }
    }
    if (!inQuotes) {
      await pushRecord();
    } else {
      // Multi-line quoted field: join with \n and keep parsing next lines.
      field += "\n";
    }
  }
  if (field.length > 0 || record.length > 0) {
    // Trailing partial record without newline.
    if (inQuotes) throw new Error(`csv: unterminated quote in ${file} (near line ${lineNo})`);
    pushField();
    await pushRecord();
  }
}

/** Streaming writer for one CSV file. */
export class CsvWriter {
  private w: ReturnType<typeof createWriteStream>;
  constructor(file: string) {
    this.w = createWriteStream(file);
  }
  write(row: (string | number | boolean)[]): void {
    const cols = row.map((val) => {
      const s = String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    this.w.write(cols.join(",") + "\n");
  }
  done(): Promise<void> {
    this.w.end();
    return new Promise((resolve) => this.w.on("close", resolve));
  }
}