import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalJsonVectorStore, TigerGraphVectorStore } from "../../rag/src/store/vectorStore.js";
import { cosineSimilarity } from "../../rag/src/embeddings.js";
import { bowEmbedVec } from "./helpers.js";

interface Rec {
  id: string;
  text: string;
}

describe("LocalJsonVectorStore", () => {
  it("searches by cosine and ranks descending, honoring k and filter", () => {
    const store = new LocalJsonVectorStore<Rec>("/tmp/opencode/ws3-nowhere.json");
    const recs: Rec[] = [
      { id: "a", text: "card testing tiny authorizations" },
      { id: "b", text: "card testing then larger purchase" },
      { id: "c", text: "moose are large herbivores" },
    ];
    for (const r of recs) store.upsert(r.id, bowEmbedVec(r.text), r);

    const q = bowEmbedVec("card testing purchase");
    const top1 = store.search(q, 1);
    expect(top1.length).toBe(1);
    // "b" shares card+testing+purchase with the query -> highest cosine.
    expect(top1[0]!.id).toBe("b");

    const filtered = store.search(q, 2, (r) => r.id === "b" || r.id === "c");
    expect(filtered.map((r) => r.id)).toEqual(["b", "c"]);

    // Sanity: cosine is symmetric.
    expect(cosineSimilarity(q, bowEmbedVec("card testing purchase"))).toBeCloseTo(1, 5);
  });

  it("round-trips through save()/load() and survives clear()", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws3-vs-"));
    const file = path.join(dir, "store.json");
    try {
      const store = new LocalJsonVectorStore<Rec>(file);
      store.upsert("a", bowEmbedVec("alpha"), { id: "a", text: "alpha" });
      store.upsert("b", bowEmbedVec("beta"), { id: "b", text: "beta" });
      store.save();
      expect(existsSync(file)).toBe(true);

      const reloaded = new LocalJsonVectorStore<Rec>(file);
      reloaded.load();
      expect(reloaded.all().length).toBe(2);
      expect(reloaded.get("a")!.text).toBe("alpha");
      expect(reloaded.search(bowEmbedVec("beta"), 1)[0]!.id).toBe("b");

      reloaded.clear();
      expect(reloaded.all().length).toBe(0);
      expect(reloaded.get("a")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("load() on a missing file behaves like an empty store", () => {
    const store = new LocalJsonVectorStore<Rec>("/tmp/opencode/ws3-definitely-missing.json");
    store.load();
    expect(store.all()).toEqual([]);
  });
});

describe("TigerGraphVectorStore adapter stub", () => {
  it("throws on construction so graph mode can't silently degrade", () => {
    expect(() => new TigerGraphVectorStore<Rec>()).toThrow(/not implemented/);
  });
});

describe("store file contract", () => {
  it("persists entries as a JSON array keyed by id for the graph import path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ws3-vs2-"));
    const file = path.join(dir, "store.json");
    try {
      const store = new LocalJsonVectorStore<Rec>(file);
      store.upsert("a", [1, 0, 0], { id: "a", text: "alpha" });
      store.save();
      const raw = JSON.parse(readFileSync(file, "utf-8")) as { id: string; embedding: number[]; record: Rec }[];
      expect(raw[0]!.id).toBe("a");
      expect(raw[0]!.embedding).toEqual([1, 0, 0]);
      expect(raw[0]!.record.text).toBe("alpha");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});