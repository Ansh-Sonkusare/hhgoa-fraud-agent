import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Extracts the policy/pattern source text directly from the dataset README
 * (`docs/DATASET_README.md`) at ingestion time, rather than hardcoding a
 * copy anywhere in `rag/`. DATASET_README.md is the single authoritative
 * source (CLAUDE.md, PRD §0) and can change; re-running
 * `pnpm --filter @hhgoa/rag run ingest` always re-derives chunks from
 * whatever's currently in it instead of a stale paste that could drift.
 */

function repoRoot(): string {
  // rag/src/sources/policyText.ts -> repo root is 3 levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "..");
}

function readReadme(): string {
  return readFileSync(path.join(repoRoot(), "docs", "DATASET_README.md"), "utf-8");
}

/** Slice `markdown` between two exact heading lines (start inclusive, end exclusive). */
export function extractSubsection(
  markdown: string,
  startHeading: string,
  endHeading: string,
): string {
  const lines = markdown.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === startHeading);
  if (startIdx === -1) {
    throw new Error(`policyText: heading not found: "${startHeading}"`);
  }
  let endIdx = lines.findIndex(
    (l, i) => i > startIdx && l.trim() === endHeading,
  );
  if (endIdx === -1) endIdx = lines.length;
  return lines.slice(startIdx, endIdx).join("\n").trim();
}

/** DATASET_README.md's "## The five known fraud patterns" section, patterns 1-5. */
export function getPatternsSectionMarkdown(): string {
  return extractSubsection(
    readReadme(),
    "## The five known fraud patterns",
    "## Regulatory references",
  );
}

/** DATASET_README.md's full "# Fraud Policy" section (actions, routing, R1-R10, 3a/3b, exposure, stopping, explaining). */
export function getFraudPolicySectionMarkdown(): string {
  return extractSubsection(readReadme(), "# Fraud Policy", "# Answer Format");
}

/**
 * DATASET_README.md renders both the 5 patterns and the 10 rules as
 * `**label.** body`
 * paragraphs under one heading, not as individual markdown headings — so a
 * heading-based chunker would lump all 5 (or all 10) into one oversized,
 * unattributable chunk. Split on the bold-label paragraph convention
 * instead; skips any leading non-bold intro paragraph automatically (the
 * regex just won't match it).
 */
export function splitBoldItems(markdown: string): { label: string; text: string }[] {
  const paragraphs = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const items: { label: string; text: string }[] = [];
  for (const p of paragraphs) {
    const m = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(p);
    if (!m) continue;
    const label = m[1]!.trim();
    const rest = m[2]!.trim();
    items.push({ label, text: rest.length > 0 ? `${label} ${rest}` : label });
  }
  return items;
}

const PATTERN_NUMBER_TO_ID: Record<number, string> = {
  1: "card_testing",
  2: "card_not_present_fraud",
  3: "card_not_present_new_device",
  4: "out_of_region_use",
  5: "account_takeover",
};

/** "1. Card testing." -> {number: 1, pattern_id: "card_testing", name: "Card testing"} */
export function parsePatternLabel(
  label: string,
): { number: number; pattern_id: string; name: string } | undefined {
  const m = /^(\d+)\.\s*(.+?)\.?$/.exec(label);
  if (!m) return undefined;
  const number = Number(m[1]);
  const pattern_id = PATTERN_NUMBER_TO_ID[number];
  if (!pattern_id) return undefined;
  return { number, pattern_id, name: m[2]! };
}

/** "R5. Card testing." -> {number: 5, title: "Card testing"} */
export function parseRuleLabel(label: string): { number: number; title: string } | undefined {
  const m = /^R(\d+)\.\s*(.+?)\.?$/.exec(label);
  if (!m) return undefined;
  return { number: Number(m[1]), title: m[2]! };
}
