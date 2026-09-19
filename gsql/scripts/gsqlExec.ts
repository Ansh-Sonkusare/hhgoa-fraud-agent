/**
 * gsql/scripts/gsqlExec.ts — WS2's own docker-exec GSQL runner. Deliberately
 * self-contained (not a deep import of graph/scripts/gsqlExec.ts) so gsql/
 * stays inside its own workstream boundary (CLAUDE.md: "own only your
 * workstream's directory"; "do not bypass workstream boundaries ... modifying
 * shared or unfinished implementation code" — importing WS1 internals would
 * couple WS2 to WS1's implementation choices instead of just its schema).
 * Mirrors the pattern documented in graph/scripts/gsqlExec.ts: the `gsql`
 * CLI only exists inside the TigerGraph container, so every call goes
 * through `docker exec`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const GSQL_BIN = "/home/tigergraph/tigergraph/app/cmd/gsql";

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
  const remoteName = `/tmp/gsqlExec_ws2_${Date.now()}_${path.basename(abs)}`;
  const cp = spawnSync("docker", ["cp", abs, `${containerName()}:${remoteName}`], {
    stdio: "inherit",
  });
  if (cp.status !== 0) {
    throw new Error(`gsqlExec: docker cp failed (exit ${cp.status})`);
  }
  return remoteName;
}

/**
 * Run one `.gsql` file through the container's gsql CLI (one statement per
 * invocation — this 4.3.0-rc1 build silently aborts multi-statement `-f`
 * batches on a later failure). Throws on non-zero exit unless allowFailure.
 */
export function runGsqlFile(
  file: string,
  opts: { graph?: string; allowFailure?: boolean } = {},
): { status: number; stdout: string } {
  const remote = copyIntoContainer(file);
  const args = ["exec", containerName(), GSQL_BIN, "-u", username(), "-p", password()];
  if (opts.graph) args.push("-g", opts.graph);
  args.push("-f", remote);
  const res = spawnSync("docker", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`gsqlExec: gsql -f ${file} exited ${res.status}\n${stdout}`);
  }
  return { status: res.status ?? -1, stdout };
}

/** Run a single inline GSQL command (e.g. "DROP QUERY foo", "INSTALL QUERY ALL"). */
export function runGsqlCmd(
  cmd: string,
  opts: { graph?: string; allowFailure?: boolean } = {},
): { status: number; stdout: string } {
  const args = ["exec", containerName(), GSQL_BIN, "-u", username(), "-p", password()];
  if (opts.graph) args.push("-g", opts.graph);
  args.push(cmd);
  const res = spawnSync("docker", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status !== 0 && !opts.allowFailure) {
    throw new Error(`gsqlExec: gsql "${cmd}" exited ${res.status}\n${stdout}`);
  }
  return { status: res.status ?? -1, stdout };
}
