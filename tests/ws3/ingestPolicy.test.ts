import { describe, expect, it } from "vitest";
import { ingestPolicy } from "../../rag/src/ingestPolicy.js";
import { fakeEmbedFn, FAKE_DIM } from "./helpers.js";

describe("ingestPolicy", () => {
  it("embeds each raw chunk with a stable vector, production-ready ids", async () => {
    const records = await ingestPolicy(fakeEmbedFn);
    expect(records.length).toBeGreaterThan(20);

    // chunk ids are zero-padded pc_NNNN so graph vertex ids are sortable.
    records.forEach((r, i) => {
      expect(r.chunk_id).toBe(`pc_${String(i).padStart(4, "0")}`);
      expect(r.embedding.length).toBe(FAKE_DIM);
      expect(r.token_count).toBeGreaterThan(0);
      expect(r.source_kind).toBeTruthy();
      expect(r.heading_path.length).toBeGreaterThan(0);
    });
  });

  it("preserves the pattern link on pattern chunks (DESCRIBES edge seed)", async () => {
    const records = await ingestPolicy(fakeEmbedFn);
    const linked = records.filter((r) => r.pattern_id !== undefined);
    expect(linked.length).toBe(5);
    expect(new Set(linked.map((r) => r.pattern_id))).toContain("card_testing");
  });
});