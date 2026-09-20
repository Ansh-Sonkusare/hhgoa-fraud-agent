#!/usr/bin/env tsx
/**
 * graph/scripts/load.ts — WS1: copy the derived CSVs from graph/build/ into
 * the TigerGraph container and run the GSQL LOADING JOBs (graph/loadingJobs/)
 * in dependency order. Idempotent: jobs are dropped and recreated each run.
 *
 * Speed: the RUN phase is parallelized. Vertex jobs depend on nothing, and
 * edge jobs only depend on the vertices being present — so all vertex jobs
 * run concurrently, then all edge jobs run concurrently (a single edge job
 * that outruns its vertex load silently drops rows, which is why the two
 * phases stay separated). Each phase is bounded by `LOAD_CONCURRENCY`
 * (default 4) concurrent `docker exec gsql` workers to avoid starving the
 * container. Job *creation* stays sequential: this 4.3.0-rc1 build silently
 * aborts multi-statement `-f` batches, and each RUN LOADING JOB only
 * executes a job that already exists.
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
import { runGsqlCmd, runGsqlFile, runGsqlCmdAsync, copyDataFile } from "./gsqlExec.js";

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

  // 1. Drop + recreate every job (sequential — fast, and this build aborts
  //    multi-statement phases, so each CREATE goes through its own gsql -f).
  for (const name of ALL_JOBS) {
    if (wanted && !wanted.has(name)) continue;
    runGsqlCmd(`DROP JOB ${name}`, { graph: G, allowFailure: true });
    const create = runGsqlFile(jobFile(name), { graph: G });
    if (!/created loading job/i.test(create.stdout)) {
      console.error(`[load] create ${name} unexpected:\n${create.stdout}`);
      process.exit(1);
    }
    console.log(`[load] created ${name}`);
  }

  // 2. Run the loading jobs — vertices first, edges second, each phase in
  //    parallel (see the header comment for why the phases stay ordered).
  const concurrency = Math.max(1, Math.min(Number(process.env.LOAD_CONCURRENCY ?? "4"), 8));
  const runPhase = async (names: string[]): Promise<void> => {
    const jobs = names.filter((name) => (wanted ? wanted.has(name) : true));
    if (jobs.length === 0) return;
    console.log(`[load] running ${jobs.length} loading job(s) concurrently (workers=${concurrency})`);
    const results: { name: string; out: string }[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const name = jobs[cursor++]!;
        const out = await runGsqlCmdAsync(`RUN LOADING JOB ${name}`, { graph: G, allowFailure: true });
        results.push({ name, out: out.stdout });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    results.sort((a, b) => jobs.indexOf(a.name) - jobs.indexOf(b.name));
    let ok = true;
    for (const { name, out } of results) {
      if (!/LOAD SUCCESSFUL/i.test(out)) {
        console.error(`[load] RUN ${name} failed (rc):\n${out.slice(0, 2000)}`);
        ok = false;
      } else {
        console.log(`[load] ran ${name}`);
      }
    }
    if (!ok) process.exit(1);
  };
  await runPhase(VERTEX_JOBS);
  await runPhase(EDGE_JOBS);
  console.log("[load] done");
}

await main();