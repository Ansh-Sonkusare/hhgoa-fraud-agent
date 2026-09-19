import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Minimal `.env` loader (no `dotenv` dependency — PRD §5 keeps the stack
 * small; Node 20+ doesn't yet default to reading a root `.env` file for us
 * outside `node --env-file`, which we don't control since `tsx` invokes
 * Node internally). Only sets vars not already present in the environment,
 * same precedence rule `dotenv` uses.
 */
function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Inline comment: strip from the first `#` that follows whitespace
    // (e.g. `TOOLS_BACKEND=fake # fake | real`). A `#` mid-token (no leading
    // space) is kept — values like `pass#1` are literal.
    const hash = value.search(/\s#/);
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.join(REPO_ROOT, ".env"));

export const REPO_ROOT_DIR = REPO_ROOT;
export const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

export const env = {
  API_PORT: Number(process.env.API_PORT ?? 4000),
  /**
   * Pace of fixture replay over SSE (ms between events). Kept fast enough
   * for a demo click-through but slow enough to see the timeline build up
   * live. Env-tunable so tests can set it to ~0.
   */
  REPLAY_INTERVAL_MS: Number(process.env.WS6_REPLAY_INTERVAL_MS ?? 350),
};
