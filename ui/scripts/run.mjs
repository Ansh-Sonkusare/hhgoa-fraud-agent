// Loads the repo-root `.env` (and a ui-local `.env` if present) into
// process.env, then runs `next dev` / `next start` on ${UI_PORT}. Same
// precedence rule as api/src/env.ts (existing env wins, so real env vars
// still override the file). `next dev -p $UI_PORT` shell-expansion can't see
// the file, so the port is computed here instead.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const uiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [path.resolve(uiDir, "../.env"), path.resolve(uiDir, ".env")];

for (const file of files) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("usage: node scripts/run.mjs dev|start");
  process.exit(1);
}
const port = Number(process.env.UI_PORT ?? 3000);
const nextBin = path.join(uiDir, "node_modules", "next", "dist", "bin", "next");
const args = mode === "dev" ? ["dev", "-p", String(port)] : ["start", "-p", String(port)];

const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));