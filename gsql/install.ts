#!/usr/bin/env tsx
/**
 * gsql/install.ts — WS2: `make verify-gsql` / `pnpm --filter @hhgoa/gsql verify`
 * entrypoint. Idempotently (re)installs every WS2 query, then runs the
 * algorithms and discovery pass so their output (Pattern kind=discovered +
 * MATCHES_PATTERN edges, community ids, hub scores) is fresh.
 *
 * Deliberately does NOT drop the graph or touch schema/data — `make
 * verify-graph` (WS1) already does DROP ALL + reload every time, which wipes
 * these queries and any discovery writes. This script must be safe to run
 * standalone, right after a `make verify-graph`, or repeatedly on its own.
 *
 * Each CREATE QUERY goes through its own `gsql -f` invocation (this
 * TigerGraph Community Edition 4.3.0-rc1 build silently aborts multi-
 * statement `-f` batches on a later failure — see graph/scripts/deploySchema.ts
 * for the same finding under WS1). All queries are then installed together
 * with one `INSTALL QUERY ALL`, which is far faster than installing each
 * query individually (~24s/query when installed alone vs. one shared compile
 * pass for the whole batch).
 *
 * Usage:
 *   tsx install.ts                       # install queries, run algorithms + discovery
 *   tsx install.ts --queries-only        # skip algorithms/discovery (faster iteration)
 *   tsx install.ts --as-of "YYYY-MM-DD HH:MM:SS"   # override the algorithms/discovery snapshot time
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { runGsqlCmd, runGsqlFile } from "./scripts/gsqlExec.js";

const GRAPH = "hhgoa_fraud";
const ROOT = import.meta.dirname;

// Algorithms/discovery are periodic batch jobs, not per-request tools, but
// every WS2 query still takes as_of (PRD §8.1) — this is the "run as of now"
// snapshot time for those batch runs, later than any real dataset timestamp
// (case-pack data runs through Dec 2016). Override with --as-of for testing
// an earlier historical snapshot.
const DEFAULT_AS_OF = "2016-12-31 23:59:59";
// Hub-collapse guard shared by community_components/label_propagation/
// community_lookup/shortest_path — see those files' header comments.
const DEFAULT_MAX_HUB_DEGREE = 25;

const QUERY_DIRS = ["queries", "detectors", "algorithms", "discovery"];

function collectQueryFiles(): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  for (const dir of QUERY_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs).sort()) {
      if (!entry.endsWith(".gsql")) continue;
      out.push({ name: entry.replace(/\.gsql$/, ""), file: path.join(abs, entry) });
    }
  }
  return out;
}

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};
const ok = (msg: string): void => console.log(`  ok    ${msg}`);

function installQueries(): boolean {
  const queries = collectQueryFiles();
  console.log(`[gsql install] ${queries.length} query file(s) found across ${QUERY_DIRS.join(", ")}`);
  let pass = true;
  for (const { name, file } of queries) {
    runGsqlCmd(`DROP QUERY ${name}`, { graph: GRAPH, allowFailure: true });
    const create = runGsqlFile(file, { graph: GRAPH, allowFailure: true });
    if (!/Successfully created queries/i.test(create.stdout)) {
      fail(`create query ${name} failed:\n${create.stdout.slice(0, 1200)}`);
      pass = false;
    } else {
      ok(`created ${name}`);
    }
  }
  if (!pass) return false;

  const inst = runGsqlCmd("INSTALL QUERY ALL", { graph: GRAPH, allowFailure: true });
  if (!/succeeded: \d+, skipped: \d+, failed: 0/i.test(inst.stdout) && !/Using installed queries/i.test(inst.stdout)) {
    fail(`INSTALL QUERY ALL did not report a clean success:\n${inst.stdout.slice(0, 2000)}`);
    pass = false;
  } else {
    ok("INSTALL QUERY ALL");
  }
  return pass;
}

/**
 * Run one installed query with positional GSQL literal args (this build's
 * `RUN QUERY` only accepts positional params, not name="value" — verified
 * empirically). Each arg must already be a valid GSQL literal (quoted
 * strings, bare numbers).
 */
function runInstalled(name: string, args: string[], timeoutHintSec = 60): boolean {
  const res = runGsqlCmd(`RUN QUERY ${name}(${args.join(", ")})`, { graph: GRAPH, allowFailure: true });
  if (res.status !== 0 || /error/i.test(res.stdout.split("\n")[0] ?? "")) {
    fail(`RUN QUERY ${name}(${args.join(", ")}) failed:\n${res.stdout.slice(0, 1200)}`);
    return false;
  }
  ok(`ran ${name}(${args.join(", ")}) (budget ~${timeoutHintSec}s)`);
  return true;
}

async function main(): Promise<void> {
  const queriesOnly = process.argv.includes("--queries-only");
  const asOfIdx = process.argv.indexOf("--as-of");
  const asOf = asOfIdx >= 0 ? process.argv[asOfIdx + 1] : DEFAULT_AS_OF;
  const asOfLit = `"${asOf}"`;
  const hubDeg = String(DEFAULT_MAX_HUB_DEGREE);

  const infra = runGsqlCmd("ls", { allowFailure: true });
  if (infra.status !== 0) {
    fail(`TigerGraph unreachable via docker exec:\n${infra.stdout.slice(0, 600)}`);
    process.exit(1);
  }
  ok("container up, gsql CLI responds");

  if (!installQueries()) {
    console.error(`\n[gsql install] FAILED installing queries (${failures} error(s))`);
    process.exit(1);
  }

  if (!queriesOnly) {
    console.log(`[gsql install] running algorithms + discovery as_of=${asOf} (writes Pattern/MATCHES_PATTERN)`);
    runInstalled("community_components", [asOfLit, hubDeg], 180);
    runInstalled("label_propagation", [asOfLit, hubDeg], 180);
    runInstalled("hub_devices", [asOfLit], 60);
    // Must run as two separate invocations, in this order -- see
    // discovery/discovery_clear.gsql's header comment (DELETE+INSERT of
    // the same vertex id within one query silently nets to a deletion).
    runInstalled("discovery_clear", [], 30);
    runInstalled("discovery_report", [asOfLit, hubDeg], 120);
  }

  if (failures > 0) {
    console.error(`\n[gsql install] FAILED with ${failures} error(s)`);
    process.exit(1);
  }
  console.log("\n[gsql install] PASS — all queries installed" + (queriesOnly ? "." : " and algorithms/discovery ran."));
}

await main();
