#!/usr/bin/env tsx
/**
 * graph/scripts/load.ts — WS1: copy the derived CSVs from graph/build/ into
 * the TigerGraph container and run the GSQL LOADING JOBs (graph/loadingJobs/)
 * in dependency order. Idempotent: jobs are dropped and recreated each run.
 *
 * Usage:
 *   tsx graph/scripts/load.ts                 # full load (vertices then edges)
 *   tsx graph/scripts/load.ts --jobs custom   # comma-separated subset
 *
 * The jobs reference /tmp/hhgoa_data/<file>.csv inside the container; the
 * files must be copied there first (done here from graph/build/).
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { runGsqlCmd, runGsqlFile, copyDataFile } from "./gsqlExec.js";

const JOB_DIR = path.resolve(import.meta.dirname, "../loadingJobs");
const BUILD_DIR = path.resolve(import.meta.dirname, "../build");
const G = "hhgoa_fraud";

/** Dependency order: vertices first, then edges. */
const VERTEX_JOBS = [
  "load_customers",
  "load_cards",
  "load_txns",
  "load_identities",
  "load_devices",
  "load_email_domains",
  "load_addresses",
  "load_fraud_cases",
  "load_case_pack_entries",
];
const EDGE_JOBS = [
  "load_owns",
  "load_made",
  "load_used_device",
  "load_billed_to",
  "load_purchaser_email",
  "load_recipient_email",
  "load_next",
  "load_resolves_to",
  "load_card_device",
  "load_card_address",
  "load_card_recipient_email",
  "load_about",
  "load_connected_to",
  "load_flagged_txn",
];
const ALL_JOBS = [...VERTEX_JOBS, ...EDGE_JOBS];

const jobsArg = process.argv.indexOf("--jobs");
const jobsValue = jobsArg >= 0 ? process.argv[jobsArg + 1] : undefined;
let wanted: Set<string> | null = null;
if (jobsValue) {
  wanted = new Set(jobsValue.split(","));
}

function jobFile(name: string): string {
  const f = path.join(JOB_DIR, `${name}.gsql`);
  if (!existsSync(f)) throw new Error(`load.ts: no loading job file for ${name} (${f})`);
  return f;
}

async function main(): Promise<void> {
  // 0. Copy every built CSV into the container's data dir.
  const csvs = readdirSync(BUILD_DIR).filter((f) => f.endsWith(".csv"));
  for (const f of csvs) copyDataFile(path.join(BUILD_DIR, f));
  console.log(`[load] copied ${csvs.length} CSVs to container /tmp/hhgoa_data/`);

  for (const name of ALL_JOBS) {
    if (wanted && !wanted.has(name)) continue;
    // Drop old job (idempotent), then recreate.
    runGsqlCmd(`DROP JOB ${name}`, { graph: G, allowFailure: true });
    const create = runGsqlFile(jobFile(name), { graph: G });
    if (!/created loading job/i.test(create.stdout)) {
      console.error(`[load] create ${name} unexpected:\n${create.stdout}`);
      process.exit(1);
    }
    console.log(`[load] created ${name}`);

    const run = runGsqlCmd(`RUN LOADING JOB ${name}`, { graph: G, allowFailure: true });
    const out = run.stdout;
    const successful = /LOAD SUCCESSFUL/i.test(out);
    if (!successful || run.status !== 0) {
      console.error(`[load] RUN ${name} failed (rc ${run.status}):\n${out.slice(0, 2000)}`);
      process.exit(1);
    }
    console.log(`[load] ran ${name}`);
  }
  console.log("[load] done");
}

await main();