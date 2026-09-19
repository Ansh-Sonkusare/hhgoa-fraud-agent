#!/usr/bin/env tsx
/**
 * graph/scripts/deploySchema.ts — WS1: deploy graph/schema.gsql to the
 * TigerGraph container, one CREATE statement per gsql invocation.
 *
 * Why one statement per invocation: this TigerGraph Community Edition
 * 4.3.0-rc1 build silently aborts a multi-statement `gsql -f` batch (RC=0,
 * zero output, nothing applied) when a later statement fails, so batch
 * deploys were not trustworthy during bring-up (see graph/README.md,
 * "Schema deployment"). Individual statements are reliable and fail loudly.
 *
 * Usage:
 *   tsx graph/scripts/deploySchema.ts                # idempotent: skip existing types
 *   tsx graph/scripts/deploySchema.ts --force        # DROP ALL, then recreate
 *   tsx graph/scripts/deploySchema.ts --file graph/schema.gsql
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGsqlFile, runGsqlCmd } from "./gsqlExec.js";

const DEFAULT_SCHEMA = path.resolve(import.meta.dirname, "../schema.gsql");
const GRAPH_NAME = "hhgoa_fraud";

/** Split a schema file into statements; strip comment-only leading lines. */
export function splitStatements(src: string): string[] {
  const chunks = src.split(/\n(?=CREATE (?:VERTEX|DIRECTED EDGE|GRAPH)\b)/);
  const out: string[] = [];
  for (const chunk of chunks) {
    const lines = chunk.replace(/\r\n/g, "\n").split("\n");
    while (lines.length > 0 && (lines[0]?.trim() ?? "").startsWith("//")) lines.shift();
    while (lines.length > 0 && (lines[lines.length - 1]?.trim() ?? "").startsWith("//")) lines.pop();
    const body = lines.join("\n").trim();
    if (body.length > 0) out.push(body);
  }
  return out;
}

export function statementKind(stmt: string): "vertex" | "edge" | "graph" | "other" {
  if (/^CREATE VERTEX\b/.test(stmt)) return "vertex";
  if (/^CREATE DIRECTED EDGE\b/.test(stmt)) return "edge";
  if (/^CREATE GRAPH\b/.test(stmt)) return "graph";
  return "other";
}

export function statementTarget(stmt: string): string {
  const m = stmt.match(/^CREATE (?:VERTEX|DIRECTED EDGE|GRAPH)\b\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m && m[1] ? m[1] : "";
}

// Prepared messages differ by object kind on this 4.3.0-rc1 build; the skip
// matcher in deploy() uses a regex covering both wordings.

function deploy(args: { force: boolean; file: string }): void {
  const src = readFileSync(args.file, "utf-8");
  const statements = splitStatements(src);

  if (args.force) {
    const res = runGsqlCmd("DROP ALL", { allowFailure: true });
    console.log(`[deploySchema] --force: DROP ALL -> ${res.stdout.trim() || "(empty)"}`);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "deploySchema-"));
  const counts = { vertex: 0, edge: 0, graph: 0, other: 0 };
  const skipped: string[] = [];
  try {
    for (const [i, stmt] of statements.entries()) {
      const kind = statementKind(stmt);
      const target = statementTarget(stmt);
      const stmtFile = path.join(dir, `stmt_${String(i).padStart(2, "0")}.gsql`);
      writeFileSync(stmtFile, `${stmt}\n`);

      const { stdout, status } = runGsqlFile(stmtFile, { allowFailure: true });
      if (status !== 0) {
        // Idempotent mode: an already-existing type is fine. Also covers the
        // CREATE GRAPH case, which reports a *different* wording ("The graph
        // name conflicts with another type or existing graph names") than the
        // vertex/edge "used by another object" message on this 4.3.0-rc1 build.
        if (!args.force && /used by another object|conflicts with another type or existing graph/i.test(stdout)) {
          console.log(`  skip  (exists) ${target} :: ${stdout.trim().split("\n")[0]}`);
          skipped.push(target);
          continue;
        }
        console.error(`[deploySchema] FAILED on statement ${i + 1}/${statements.length} (${target}):\n${stdout}`);
        process.exit(1);
      }
      counts[kind] += 1;
      const okLine = stdout.trim().split("\n").find((l) => /created|success/i.test(l));
      console.log(`  ok    ${target} :: ${okLine ?? "done"}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    `[deploySchema] applied ${counts.vertex} vertices, ${counts.edge} edges, ` +
      `${counts.graph} graph, ${counts.other} other; skipped-existing: ${skipped.join(", ") || "none"}`,
  );

  const ls = runGsqlCmd("ls").stdout;
  const hasGraph = /Graphs:[\s\S]*?^\s*- /m.test(ls) && ls.includes(GRAPH_NAME);
  if (!hasGraph) {
    console.error(`[deploySchema] WARNING: graph ${GRAPH_NAME} not found in catalog after deploy`);
    process.exit(1);
  }
  console.log(`[deploySchema] graph ${GRAPH_NAME} present in catalog.`);
}

const args = process.argv.slice(2);
const fileArg = args.indexOf("--file");
const fileValue = fileArg >= 0 ? args[fileArg + 1] : undefined;
let file = DEFAULT_SCHEMA;
if (fileValue) file = path.resolve(fileValue);
deploy({ force: args.includes("--force"), file });