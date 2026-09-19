import { approxTokenCount } from "./tokenCount.js";

/** A chunk before it's been assigned an id/embedding/pattern link. */
export interface RawChunk {
  /** Dot-joined heading path, e.g. "Fraud Policy > Rules > R5". Empty for flat text. */
  heading_path: string;
  text: string;
  token_count: number;
}

const TARGET_TOKENS = 400; // PRD §11: "~300-500 tokens"
const MIN_TOKENS = 300;
const MAX_TOKENS = 500;

/**
 * Chunk markdown by heading (h1-h4), then further split any section that's
 * still too long by paragraph, packing paragraphs greedily up to
 * MAX_TOKENS. Sections shorter than MIN_TOKENS are left as their own chunk
 * (a rule like R5 is a handful of sentences — better to keep one policy
 * rule intact and provenance-clean than to pad it by merging with its
 * neighbor, which would blur `source_doc`/heading attribution).
 */
export function chunkMarkdown(markdown: string): RawChunk[] {
  const lines = markdown.split(/\r?\n/);
  const headingStack: { level: number; text: string }[] = [];
  const sections: { heading_path: string; lines: string[] }[] = [];
  let current: { heading_path: string; lines: string[] } = {
    heading_path: "",
    lines: [],
  };

  const flush = () => {
    if (current.lines.some((l) => l.trim().length > 0)) {
      sections.push(current);
    }
  };

  for (const line of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      const text = m[2]!.trim();
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      current = {
        heading_path: headingStack.map((h) => h.text).join(" > "),
        lines: [],
      };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const chunks: RawChunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (text.length === 0) continue;
    const tokens = approxTokenCount(text);
    if (tokens <= MAX_TOKENS) {
      chunks.push({
        heading_path: section.heading_path,
        text,
        token_count: tokens,
      });
      continue;
    }
    // Too long: pack paragraphs greedily into ~TARGET_TOKENS chunks.
    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    let buf: string[] = [];
    let bufTokens = 0;
    const pushBuf = () => {
      if (buf.length === 0) return;
      const t = buf.join("\n\n").trim();
      chunks.push({
        heading_path: section.heading_path,
        text: t,
        token_count: approxTokenCount(t),
      });
      buf = [];
      bufTokens = 0;
    };
    for (const p of paragraphs) {
      const pTokens = approxTokenCount(p);
      if (bufTokens > 0 && bufTokens + pTokens > TARGET_TOKENS) {
        pushBuf();
      }
      buf.push(p);
      bufTokens += pTokens;
      if (bufTokens >= MIN_TOKENS && bufTokens >= TARGET_TOKENS) {
        pushBuf();
      }
    }
    pushBuf();
  }
  return chunks;
}

/** Chunk plain (non-markdown) prose by paragraph, same size target. Used for
 * fetched regulatory text that may not carry clean markdown headings. */
export function chunkProse(text: string, headingPath: string): RawChunk[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: RawChunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  const pushBuf = () => {
    if (buf.length === 0) return;
    const t = buf.join("\n\n").trim();
    chunks.push({ heading_path: headingPath, text: t, token_count: approxTokenCount(t) });
    buf = [];
    bufTokens = 0;
  };
  for (const p of paragraphs) {
    const pTokens = approxTokenCount(p);
    if (bufTokens > 0 && bufTokens + pTokens > MAX_TOKENS) {
      pushBuf();
    }
    buf.push(p);
    bufTokens += pTokens;
    if (bufTokens >= TARGET_TOKENS) {
      pushBuf();
    }
  }
  pushBuf();
  return chunks;
}
