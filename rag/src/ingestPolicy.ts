import { chunkMarkdown } from "./chunk.js";
import { approxTokenCount } from "./tokenCount.js";
import type { PolicyChunkRecord, SourceDocKind } from "./types.js";
import {
  extractSubsection,
  getFraudPolicySectionMarkdown,
  getPatternsSectionMarkdown,
  parsePatternLabel,
  parseRuleLabel,
  splitBoldItems,
} from "./sources/policyText.js";
import { REGULATORY_DOCS } from "./sources/regulatoryText.js";

interface RawPolicyChunk {
  source_doc: string;
  source_kind: SourceDocKind;
  heading_path: string;
  text: string;
  pattern_id?: string;
}

/** Everything except the embedding step, exposed separately so tests can
 * exercise chunking/linking deterministically without invoking the model. */
export function buildRawPolicyChunks(): RawPolicyChunk[] {
  const raw: RawPolicyChunk[] = [];

  // 1. The five documented patterns — one chunk per pattern, bold-item split
  // (see policyText.ts header comment for why generic heading-chunking
  // doesn't work for this section).
  for (const item of splitBoldItems(getPatternsSectionMarkdown())) {
    const parsed = parsePatternLabel(item.label);
    if (!parsed) continue; // skips the section's non-bold intro paragraph
    raw.push({
      source_doc: "README.md#the-five-known-fraud-patterns",
      source_kind: "pattern",
      heading_path: `The five known fraud patterns > ${item.label}`,
      text: item.text,
      pattern_id: parsed.pattern_id,
    });
  }

  // 2. Fraud Policy: R1-R10 special-cased (same bold-item issue as above),
  // then the rest of the section chunked generically by heading.
  const fraudPolicyMd = getFraudPolicySectionMarkdown();
  const rulesMd = extractSubsection(
    fraudPolicyMd,
    "### 3. Rules",
    "### 3a. A case is not a report",
  );
  for (const item of splitBoldItems(rulesMd)) {
    const parsed = parseRuleLabel(item.label);
    if (!parsed) continue;
    raw.push({
      source_doc: "README.md#fraud-policy",
      source_kind: "policy",
      heading_path: `Fraud Policy > Rules > ${item.label}`,
      text: item.text,
      // No single pattern_id: a rule can govern several patterns.
      // retrieve.ts resolves rule chunks -> patterns via PATTERNS[].rule_refs.
    });
  }
  const withoutRules = fraudPolicyMd.replace(
    rulesMd,
    "### 3. Rules\n\n(Individual rules R1-R10 are indexed as their own chunks.)",
  );
  // The extracted markdown still begins with the `# Fraud Policy` heading,
  // so chunkMarkdown's heading_paths already carry the "Fraud Policy"
  // prefix — don't prepend it again.
  for (const c of chunkMarkdown(withoutRules)) {
    raw.push({
      source_doc: "README.md#fraud-policy",
      source_kind: "policy",
      heading_path: c.heading_path,
      text: c.text,
    });
  }

  // 3. Regulatory references (best-effort; see sources/regulatoryText.ts).
  for (const doc of REGULATORY_DOCS) {
    for (const c of chunkMarkdown(doc.markdown)) {
      raw.push({
        source_doc: doc.source_doc,
        source_kind: "regulatory",
        heading_path: c.heading_path,
        text: c.text,
      });
    }
  }

  return raw;
}

/**
 * Chunk + embed policy/pattern/regulatory text into `PolicyChunkRecord`s
 * ready to upsert into a `VectorStore<PolicyChunkRecord>` (PRD §11 step 1
 * of retrieval: "vector top-k seeds"). `embedFn` is injectable so tests can
 * swap in a cheap deterministic fake instead of loading the real model.
 */
export async function ingestPolicy(
  embedFn: (texts: string[]) => Promise<number[][]>,
): Promise<PolicyChunkRecord[]> {
  const raw = buildRawPolicyChunks();
  const embeddings = await embedFn(raw.map((c) => c.text));
  return raw.map((c, i) => ({
    chunk_id: `pc_${String(i).padStart(4, "0")}`,
    text: c.text,
    source_doc: c.source_doc,
    source_kind: c.source_kind,
    heading_path: c.heading_path,
    pattern_id: c.pattern_id,
    embedding: embeddings[i]!,
    token_count: approxTokenCount(c.text),
  }));
}
