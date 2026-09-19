#!/usr/bin/env tsx
/**
 * graph/scripts/gsqlExec.ts — WS1 helper: run a .gsql file (or an inline
 * command) against the TigerGraph Community Edition container via
 * `docker exec`, since the `gsql` CLI only exists inside the container
 * (PRD §18.1, docs/decisions.md). TypeScript wrapper around child_process
 * per CLAUDE.md's "no non-TS general-purpose languages" rule — this file is
 * the reusable tool the task brief asked for; there is no separate .sh file.
 *
 * Usage:
 *   tsx graph/scripts/gsqlExec.ts --file graph/schema.gsql
 *   tsx graph/scripts/gsqlExec.ts --cmd "ls"
 *   tsx graph/scripts/gsqlExec.ts --file graph/queries/foo.gsql --graph hhgoa_fraud
 *
 * Env (see .env / .env.example):
 *   TIGERGRAPH_CONTAINER   default: hhgoa-tigergraph
 *   TIGERGRAPH_USERNAME    default: tigergraph
 *   TIGERGRAPH_PASSWORD    default: tigergraph
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const GSQL_BIN = "/home/tigergraph/tigergraph/app/cmd/gsql";

interface Args {
  file?: string;
  cmd?: string;
  graph?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--cmd") out.cmd = argv[++i];
    else if (a === "--graph") out.graph = argv[++i];
  }
  return out;
}

function containerName(): string {
  return process.env.TIGERGRAPH_CONTAINER ?? "hhgoa-tigergraph";
}
function username(): string {
  return process.env.TIGERGRAPH_USERNAME ?? "tigergraph";
}
function password(): string {
  return process.env.TIGERGRAPH_PASSWORD ?? "tigergraph";
}

/** Copy a local file into the container at /tmp/<basename> and return that path. */
function copyIntoContainer(localPath: string): string {
  const abs = path.resolve(localPath);
  if (!existsSync(abs)) {
    throw new Error(`gsqlExec: file not found: ${abs}`);
  }
  const remoteName = `/tmp/gsqlExec_${Date.now()}_${path.basename(abs)}`;
  const cp = spawnSync("docker", ["cp", abs, `${containerName()}:${remoteName}`], {
    stdio: "inherit",
  });
  if (cp.status !== 0) {
    throw new Error(`gsqlExec: docker cp failed (exit ${cp.status})`);
  }
  return remoteName;
}

/**
 * Run one or more `.gsql` files through the container's gsql CLI, in a
 * single session (so USE GRAPH / multi-statement files work), and return
 * {status, stdout}. Throws on a non-zero gsql exit code unless
 * `allowFailure` is set (used by verify.ts to probe without dying).
 */
export function runGsqlFile(
  file: string,
  opts: { graph?: string; allowFailure?: boolean } = {},
): { status: number; stdout: string } {
  const remote = copyIntoContainer(file);
  const args = ["exec", containerName(), GSQL_BIN, "-u", username(), "-p", password()];
  if (opts.graph) args.push("-g", opts.graph);
  args.push("-f", remote);
  const res = spawnSync("docker", args, { encoding: "utf-8" });
  const stdout = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`gsqlExec: gsql -f ${file} exited ${res.status}\n${stdout}`);
  }
  return { status: res.status ?? -1, stdout };
}

/** Run a single inline GSQL command (e.g. "ls", "show job xyz"). */
export function runGsqlCmd(
  cmd: string,
  opts: { graph?: string; allowFailure?: boolean } = {},
): { status: number; stdout: string } {
  const args = ["exec", containerName(), GSQL_BIN, "-u", username(), "-p", password()];
  if (opts.graph) args.push("-g", opts.graph);
  args.push(cmd);
  const res = spawnSync("docker", args, { encoding: "utf-8" });
  const stdout = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`gsqlExec: gsql "${cmd}" exited ${res.status}\n${stdout}`);
  }
  return { status: res.status ?? -1, stdout };
}

/** Copy a local file into the container's filesystem, returning the remote path (for LOADING JOBs). */
export function copyDataFile(localPath: string, remoteDir = "/tmp/hhgoa_data"): string {
  const abs = path.resolve(localPath);
  if (!existsSync(abs)) {
    throw new Error(`gsqlExec: data file not found: ${abs}`);
  }
  spawnSync("docker", ["exec", containerName(), "mkdir", "-p", remoteDir], { stdio: "inherit" });
  const remotePath = `${remoteDir}/${path.basename(abs)}`;
  const cp = spawnSync("docker", ["cp", abs, `${containerName()}:${remotePath}`], {
    stdio: "inherit",
  });
  if (cp.status !== 0) {
    throw new Error(`gsqlExec: docker cp (data) failed (exit ${cp.status})`);
  }
  return remotePath;
}

// CLI entrypoint. Compare against the resolved path (argv[1] may be relative
// while import.meta.url is absolute).
const isMain =
  process.argv[1] &&
  import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.file) {
    const { stdout, status } = runGsqlFile(args.file, { graph: args.graph, allowFailure: true });
    console.log(stdout);
    process.exit(status === 0 ? 0 : 1);
  } else if (args.cmd) {
    const { stdout, status } = runGsqlCmd(args.cmd, { graph: args.graph, allowFailure: true });
    console.log(stdout);
    process.exit(status === 0 ? 0 : 1);
  } else {
    console.error("Usage: tsx graph/scripts/gsqlExec.ts --file <path.gsql> | --cmd <gsql command> [--graph <name>]");
    process.exit(2);
  }
}
