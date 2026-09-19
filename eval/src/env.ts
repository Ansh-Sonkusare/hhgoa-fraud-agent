import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Repo root (grandparent of eval/). */
export function repoRoot(): string {
  return path.resolve(evalDir, "..");
}

/**
 * Loads the repo-root `.env` into process.env with existing-env-wins
 * precedence (mirrors api/src/env.ts; eval/ can't import from the WS6
 * package). Cheap to call — it is a no-op on later invocations.
 */
export function loadEnv(): void {
  const files = [path.join(repoRoot(), ".env")];
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
}

/** `env("NAME", default)` with the repo convention of falling back to a default. */
export function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Parse an `HHH:MM` (or plain number) mduration into seconds for timeouts. */
export function parseSeconds(v: string): number {
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const m = /^(\d+):(\d{1,2})$/.exec(v.trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return 0;
}