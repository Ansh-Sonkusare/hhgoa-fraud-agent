// WS6 screenshot capture (blog / PRD §16 WS6 "screenshots for blog").
// Launches the locally-cached Playwright chromium from playwright-core
// (no browser download) and captures full-page PNGs of the live-mode UI.
//
// The UI + API must already be running on UI_PORT (default 3000) with
// RUN_SOURCE=live. On NixOS, run inside the lib-provided shell:
//
//   nix-shell /tmp/opencode/chrome-libs.nix --run 'node scripts/screenshot.mjs'
//
// Targets are captured in order; the details page's live run completes in a
// few seconds with the default mock LLM, so waiting on "Investigation
// complete" is reliable.
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(uiDir, "screenshots");
mkdirSync(outDir, { recursive: true });

const base = `http://localhost:${process.env.UI_PORT ?? 3000}`;

const targets = [
  {
    name: "ws6-live-case-hhg-001",
    path: "/cases/HHG-001",
    // The verdict banner replaces the transient "complete" text once the
    // answer refetches, so wait on the banner itself.
    waitFor: "text=Fraud confirmed",
    extraWaitMs: 2500,
  },
  {
    name: "ws6-live-streaming",
    // A case nobody has opened yet → screenshot while its real agent run is
    // mid-stream (~1.4s in; runs take ~3s with the mock LLM).
    path: "/cases/HHG-004",
    waitMs: 1400,
  },
  {
    name: "ws6-live-queue",
    path: "/",
    waitFor: "text=fraud",
    extraWaitMs: 2000,
  },
  {
    name: "ws6-live-approvals",
    path: "/approvals",
    waitMs: 1500,
  },
];

const browser = await chromium.launch({
  headless: true,
  // Container/host sandbox restrictions (no userns) → run sandboxless like
  // the Playwright docker images do.
  chromiumSandbox: false,
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const t of targets) {
    await page.goto(`${base}${t.path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (t.waitFor) {
      await page.waitForSelector(t.waitFor, { timeout: 60000 });
    }
    if (t.waitMs) {
      await page.waitForTimeout(t.waitMs);
    }
    await page.screenshot({ path: path.join(outDir, `${t.name}.png`), fullPage: true });
    console.log(`captured ${t.name}.png`);
  }
} finally {
  await browser.close();
}