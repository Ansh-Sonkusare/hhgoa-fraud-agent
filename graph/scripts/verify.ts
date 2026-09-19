#!/usr/bin/env tsx
/**
 * graph/scripts/verify.ts — WS1: `make verify-graph` implementation.
 *
 * Pass/fail stages, in order:
 *   1. infra    — TigerGraph container reachable via docker exec (gsqlExec.ts)
 *   2. schema   — deploySchema.ts (idempotent) ensures vertex/edge types exist
 *   3. data     — deterministic graph load: DROP GRAPH CASCADE (stale data
 *                 from earlier runs must never skew counts), redeploy the
 *                 schema, then run load.ts against graph/build/*.csv
 *   4. queries  — (re)create + install the WS1 sample/verification queries
 *   5. counts   — run graph_stats_vertices() + graph_stats() and compare the
 *                 loaded counts against graph/build/*.csv (the files the
 *                 loading jobs read). Vertex mismatches below expectation are
 *                 hard failures; edge mismatches are reported the same way
 *                 (a loaded edge type that is 0 while its CSV is non-empty is
 *                 a hard failure, otherwise deltas are warnings — the loading
 *                 jobs can silently skip edges whose endpoints weren't loaded).
 *
 * Expected counts are derived from the build CSVs at runtime, NOT hardcoded.
 * graph/build is produced by `pnpm prepare-load`; see scripts/prepareLoadFiles.ts.
 * A smoke build (e.g. --max-transactions 2500) is a valid input — verify checks
 * "what we prepared was loaded", not a hardcoded README size.
 *
 * Usage:
 *   tsx graph/scripts/verify.ts            # all stages
 *   tsx graph/scripts/verify.ts --stages infra,schema   # subset
 *   tsx graph/scripts/verify.ts --skip-load             # all but the data load
 *
 * Exits 0 only when every enabled hard stage passes.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { eachRow } from "./lib/csv.js";
import { runGsqlCmd, runGsqlFile } from "./gsqlExec.js";

const GRAPH = "hhgoa_fraud";
const GRAPH_DIR = path.resolve(import.meta.dirname, "..");
const BUILD_DIR = path.join(GRAPH_DIR, "build");
const QUERIES_DIR = path.join(GRAPH_DIR, "queries");

/**
 * Run a sibling script under the repo's installed tsx runtime. The npm-installed
 * `node_modules/.bin/tsx` is a shell shim (not JS), so it cannot be spawned via
 * `process.execPath`; the real CLI is node_modules/tsx/dist/cli.mjs.
 */
function runTsx(scriptName: string, args: string[] = []): { ok: boolean; out: string } {
  const tsxCli = path.join(GRAPH_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(import.meta.dirname, scriptName);
  if (!existsSync(tsxCli)) {
    return {
      ok: false,
      out: `node_modules/tsx/cli.mjs missing — run \`pnpm install\` at the repo root first`,
    };
  }
  const res = spawnSync(process.execPath, [tsxCli, script, ...args], { encoding: "utf-8" });
  return { ok: res.status === 0, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** Queries WS1 owns and `make verify-graph` must install (scratch queries qcnt*.gsql are excluded). */
const WS1_QUERIES = [
  "sample_txn_explain",
  "sample_card_velocity",
  "sample_link_analysis",
  "graph_stats",
  "graph_stats_vertices",
];

const VERTEX_EXPECTATION: Record<string, string[]> = {
  Customer: ["customers.csv"],
  Card: ["cards.csv", "stub_cards.csv"],
  Txn: ["txns.csv"],
  Identity: ["identities.csv"],
  Device: ["devices.csv"],
  EmailDomain: ["email_domains.csv"],
  Address: ["addresses.csv"],
  FraudCase: ["fraud_cases.csv"],
  CasePackEntry: ["case_pack_entries.csv"],
  Finding: [],
  ActionRecord: [],
  Decision: [],
  EvidenceItem: [],
  Pattern: [],
  PolicyChunk: [],
  EvidenceType: [],
};

/** Print alias used by graph_stats_vertices.gsql for each vertex type. */
const VERTEX_ALIAS: Record<string, string> = {
  Customer: "customers",
  Card: "cards",
  Txn: "txns",
  Identity: "identities",
  Device: "devices",
  EmailDomain: "email_domains",
  Address: "addresses",
  FraudCase: "fraud_cases",
  CasePackEntry: "case_pack_entries",
  Finding: "findings",
  ActionRecord: "action_records",
  Decision: "decisions",
  EvidenceItem: "evidence_items",
  Pattern: "patterns",
  PolicyChunk: "policy_chunks",
  EvidenceType: "evidence_types",
};

const EDGE_EXPECTATION: Record<string, string[]> = {
  OWNS: ["owns.csv"],
  MADE: ["made.csv"],
  USED_DEVICE: ["used_device.csv"],
  BILLED_TO: ["billed_to.csv"],
  PURCHASER_EMAIL: ["purchaser_email.csv"],
  RECIPIENT_EMAIL: ["recipient_email.csv"],
  NEXT: ["next.csv"],
  RESOLVES_TO: ["resolves_to.csv"],
  CARD_DEVICE: ["card_device.csv"],
  CARD_ADDRESS: ["card_address.csv"],
  CARD_RECIPIENT_EMAIL: ["card_recipient_email.csv"],
  CONNECTED_TO: ["connected_to.csv"],
  ABOUT: ["about_card.csv", "about_customer.csv", "about_txn.csv"],
  FLAGGED_TXN: ["flagged_txn.csv"],
  HAS_FINDING: [],
  HAS_ACTION: [],
  HAS_DECISION: [],
  HAS_EVIDENCE: [],
  MATCHES_PATTERN: [],
  SIMILAR_TO: [],
  CITES_CHUNK: [],
  DESCRIBES: [],
  REQUIRES_EVIDENCE: [],
};

/** Graph_stats.gsql print alias for each loaded edge type. */
const EDGE_ALIAS: Record<string, string> = {
  OWNS: "edges_owns",
  MADE: "edges_made",
  USED_DEVICE: "edges_used_device",
  BILLED_TO: "edges_billed_to",
  PURCHASER_EMAIL: "edges_purchaser_email",
  RECIPIENT_EMAIL: "edges_recipient_email",
  NEXT: "edges_next",
  RESOLVES_TO: "edges_resolves_to",
  CARD_DEVICE: "edges_card_device",
  CARD_ADDRESS: "edges_card_address",
  CARD_RECIPIENT_EMAIL: "edges_card_recipient_email",
  CONNECTED_TO: "edges_connected_to",
  ABOUT: "edges_about",
  FLAGGED_TXN: "edges_flagged_txn",
};

const stagesIdx = process.argv.indexOf("--stages");
const stagesValue = stagesIdx >= 0 ? process.argv[stagesIdx + 1] : undefined;
const enabledStages = new Set<string>(
  (stagesValue
    ? stagesValue.split(",")
    : ["infra", "schema", "data", "queries", "counts"]
  ).map((s) => s.trim()),
);
const skipLoad = process.argv.includes("--skip-load");
const verbose = process.argv.includes("--verbose");

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`  FAIL  ${msg}`);
};
const ok = (msg: string): void => {
  console.log(`  ok    ${msg}`);
};

/** Sum data rows (first line is a header) of one or more build CSVs, reusing the same reader as prepareLoadFiles. */
async function countCsvRows(files: string[]): Promise<number> {
  let n = 0;
  for (const file of files) {
    const p = path.join(BUILD_DIR, file);
    if (!existsSync(p)) continue;
    let header = true;
    await eachRow(p, () => {
      if (header) {
        header = false;
        return;
      }
      n += 1;
    });
  }
  return n;
}

const done = new Promise<void>((resolve) => process.on("exit", resolve));

const expected: { vertex: Record<string, number>; edge: Record<string, number> } = {
  vertex: {},
  edge: {},
};

/** Precompute expected counts from the build CSVs before any gsql call (component of main). */
async function loadRowCounts(): Promise<void> {
  for (const type of Object.keys(VERTEX_EXPECTATION)) {
    expected.vertex[type] = await countCsvRows(VERTEX_EXPECTATION[type] ?? []);
  }
  for (const type of Object.keys(EDGE_EXPECTATION)) {
    expected.edge[type] = await countCsvRows(EDGE_EXPECTATION[type] ?? []);
  }
}

// ---------------------------------------------------------------------------
// Stage 1: infra
// ---------------------------------------------------------------------------
export function stageInfra(): boolean {
  console.log(`[verify] stage 1/5 infra  (${GRAPH})`);
  let pass = true;
  const probe = runGsqlCmd("ls", { allowFailure: true });
  if (probe.status !== 0) {
    const out = probe.stdout;
    if (/no such container|Cannot connect to the Docker daemon/i.test(out)) {
      fail(
        "TigerGraph container not running. Start it with `docker compose up -d` " +
          "(image tigergraph/community:4.3.0-rc1 must be loaded first — see docker-compose.yml).",
      );
    } else {
      fail(`gsql CLI unreachable (exit ${probe.status}):\n${out.slice(0, 600)}`);
    }
    pass = false;
  } else {
    ok("container up, gsql CLI responds");
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Stage 2: schema
// ---------------------------------------------------------------------------
export function stageSchema(): boolean {
  console.log(`[verify] stage 2/5 schema  (${GRAPH})`);
  let pass = true;
  const res = runTsx("deploySchema.ts");
  if (!res.ok) {
    fail(`deploySchema.ts failed:\n${res.out.slice(0, 1200)}`);
    pass = false;
  } else {
    if (verbose) console.log(res.out);
    ok("schema deployed / already present (graph hhgoa_fraud in catalog)");
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Stage 3: data
// ---------------------------------------------------------------------------
export function stageData(): boolean {
  console.log(`[verify] stage 3/5 data    (${GRAPH})`);
  let pass = true;

  // This 4.3.0-rc1 build does NOT wipe the data store on `DROP GRAPH` (nor
  // does it expose a REST DELETE for graphs): a recreated schema immediately
  // relinks the old partitions, so previously loaded vertices/edges survive.
  // `DROP ALL` is the only reliable reset, and deploySchema --force does that
  // before recreating the schema. Without it, counts are silently stale.
  const reset = runTsx("deploySchema.ts", ["--force"]);
  if (!reset.ok) {
    fail(`deploySchema.ts --force (reset) failed:\n${reset.out.slice(0, 1200)}`);
    pass = false;
    return pass;
  }
  ok("reset: DROP ALL wiped the store, schema recreated");

  const load = runTsx("load.ts");
  if (!load.ok) {
    fail(`load.ts exited non-zero; counts will be stale.\n${load.out.slice(0, 2000)}`);
    pass = false;
  } else {
    if (verbose) console.log(load.out);
    ok("data loaded from graph/build/*.csv");
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Stage 4: queries
// ---------------------------------------------------------------------------
export function stageQueries(): boolean {
  console.log(`[verify] stage 4/5 queries (${GRAPH})`);
  let pass = true;
  for (const name of WS1_QUERIES) {
    const file = path.join(QUERIES_DIR, `${name}.gsql`);
    if (!existsSync(file)) {
      fail(`query file missing: ${file}`);
      pass = false;
      continue;
    }
    // Idempotent: drop (if present) then recreate.
    runGsqlCmd(`DROP QUERY ${name}`, { graph: GRAPH, allowFailure: true });
    const create = runGsqlFile(file, { graph: GRAPH });
    if (!/create/i.test(create.stdout) && !/created/i.test(create.stdout)) {
      fail(`create query ${name} unexpected:\n${create.stdout.slice(0, 600)}`);
      pass = false;
    } else {
      ok(`created ${name}`);
    }
  }
  const inst = runGsqlCmd("INSTALL QUERY ALL", { graph: GRAPH, allowFailure: true });
  if (!/Success|succeeded|successfully/i.test(inst.stdout)) {
    fail(`INSTALL QUERY ALL failed (rc ${inst.status}):\n${inst.stdout.slice(0, 1200)}`);
    pass = false;
  } else {
    ok("INSTALL QUERY ALL");
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Stage 5: counts
// ---------------------------------------------------------------------------
export function stageCounts(): boolean {
  console.log(`[verify] stage 5/5 counts  (${GRAPH})`);
  let pass = true;

  const vRun = runGsqlCmd("RUN QUERY graph_stats_vertices()", { graph: GRAPH, allowFailure: true });
  if (vRun.status !== 0) {
    fail(`RUN QUERY graph_stats_vertices() failed:\n${vRun.stdout.slice(0, 800)}`);
    return false;
  }
  const eRun = runGsqlCmd("RUN QUERY graph_stats()", { graph: GRAPH, allowFailure: true });
  if (eRun.status !== 0) {
    fail(`RUN QUERY graph_stats() failed:\n${eRun.stdout.slice(0, 800)}`);
    return false;
  }

  const extract = (out: string, key: string): number | null => {
    const m = out.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  console.log("  vertex counts (loaded / expected):");
  for (const type of Object.keys(VERTEX_EXPECTATION)) {
    const alias = VERTEX_ALIAS[type];
    if (!alias) {
      fail(`vertex ${type}: no print alias registered in VERTEX_ALIAS`);
      pass = false;
      continue;
    }
    const loaded = extract(vRun.stdout, alias);
    const want = expected.vertex[type] ?? 0;
    if (loaded === null) {
      fail(`vertex ${type}: alias "${alias}" not found in graph_stats_vertices output`);
      pass = false;
      continue;
    }
    const verdict = want === 0 ? "info" : loaded < want ? "MISSING" : loaded > want ? "OVER" : "match";
    console.log(
      `      ${type.padEnd(14)} ${String(loaded).padStart(7)} / ${String(want).padStart(7)}  [${verdict}]`,
    );
    if (verdict === "MISSING") {
      fail(`vertex ${type}: loaded ${loaded} < expected ${want}`);
      pass = false;
    } else if (verdict === "OVER") {
      console.error(`  WARN  vertex ${type}: loaded ${loaded} > expected ${want}`);
    }
  }

  console.log("  edge counts (loaded / expected):");
  for (const type of Object.keys(EDGE_EXPECTATION)) {
    const alias = EDGE_ALIAS[type];
    const want = expected.edge[type] ?? 0;
    if (!alias) {
      // Schema-only edge with no load source: nothing to verify against. Only a
      // hard fail if a build CSV actually expects edges for it.
      if (want !== 0) {
        fail(`edge ${type}: no print alias registered in EDGE_ALIAS`);
        pass = false;
      } else {
        console.log(`      ${type.padEnd(22)} ${"n/a".padStart(7)} / ${String(want).padStart(7)}  [info]`);
      }
      continue;
    }
    const loaded = extract(eRun.stdout, alias);
    if (loaded === null) {
      fail(`edge ${type}: alias "${alias}" not found in graph_stats output`);
      pass = false;
      continue;
    }
    const verdict =
      want === 0 ? "info" : loaded === 0 ? "EMPTY" : loaded < want ? "part" : loaded > want ? "OVER" : "match";
    console.log(
      `      ${type.padEnd(22)} ${String(loaded).padStart(7)} / ${String(want).padStart(7)}  [${verdict}]`,
    );
    if (verdict === "EMPTY") {
      fail(`edge ${type}: 0 edges loaded but ${want} expected — check loading job`);
      pass = false;
    } else if (verdict === "part") {
      console.error(
        `  WARN  edge ${type}: loaded ${loaded} < expected ${want} (loader drops edges whose endpoints weren't loaded)`,
      );
    } else if (verdict === "OVER") {
      console.error(`  WARN  edge ${type}: loaded ${loaded} > expected ${want}`);
    }
  }

  return pass;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[verify] graph verification for ${GRAPH} (build dir: ${BUILD_DIR})`);
  if (!existsSync(BUILD_DIR)) {
    fail(`graph/build missing — run \`pnpm prepare-load\` first (see graph/scripts/prepareLoadFiles.ts)`);
    process.exit(1);
  }

  await loadRowCounts();

  if (enabledStages.has("infra")) stageInfra();
  if (failures > 0 && enabledStages.has("infra")) {
    console.error(
      "\n[verify] infra stage failed — TigerGraph must be reachable before schema/queries/counts can run.",
    );
    process.exit(1);
  }

  if (enabledStages.has("schema")) stageSchema();
  if (enabledStages.has("data") && !skipLoad) stageData();
  if (enabledStages.has("queries")) stageQueries();
  if (enabledStages.has("counts")) stageCounts();

  if (failures > 0) {
    console.error(`\n[verify] FAILED with ${failures} error(s)`);
    process.exit(1);
  }
  console.log("\n[verify] PASS — schema, queries, and counts all check out.");
}

await main();
void done;