// WS6: proxy same-origin `/backend/*` requests (REST + SSE) to the Fastify
// API. This keeps `API_BASE_URL` a server-side-only env var (as named in
// .env.example, no NEXT_PUBLIC_ prefix needed) and avoids CORS for the UI's
// own calls — the browser only ever talks to the Next.js origin. The API
// also has @fastify/cors enabled independently, for direct API access
// (curl, tests, a future non-Next client).
//
// API_BASE_URL / UI_PORT come from the repo-root `.env` (see
// scripts/run.mjs). This loader applies the same file-based defaults here
// so `rewrites` works under `next build`/`next start` too, not just via the
// dev launcher. Real environment variables still win.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) {
  for (const rawLine of readFileSync(envFile, "utf8").split("\n")) {
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

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // SSE (the live investigation timeline) must stream uncompressed:
  // EventSource rejects gzip-encoded streams, and Next's built-in
  // compression would otherwise gzip the proxied /backend/* responses the
  // moment the browser advertises Accept-Encoding. Fine for this dev/demo
  // tool — the payloads are tiny event frames.
  compress: false,
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${API_BASE_URL}/:path*` }];
  },
};

export default nextConfig;