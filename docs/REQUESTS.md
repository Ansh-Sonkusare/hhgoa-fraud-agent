# Cross-workstream requests

Per PRD.md §0: each workstream owns only its own directory. If a workstream needs something changed in a directory it doesn't own (a contract, a schema field, another workstream's tool signature), it writes the request here instead of editing that directory directly.

Format per request:

```
## <date> — WS<N> asks WS<M>: <one-line summary>
What's needed:
Why:
Blocking: yes/no
Resolved: (leave blank until actioned, then note the commit/PR)
```

_No requests yet._

## 2026-09-18 — WS3 asks WS1: graph/vector schema + installed query shape for RAG reads and case memory

What's needed: WS3 (`rag/`) currently runs against a clearly-marked local adapter (`rag/src/store/vectorStore.ts`) because `graph/schema.gsql` did not exist in this worktree when WS3 implemented. To swap in real TigerGraph storage behind the existing `VectorStore<T>` interface and wire the "graph expansion" half of hybrid retrieval (PRD §11 step 2) to real vertices, WS1 must provide:

1. `PolicyChunk` vertex (PRD §7) with a vector attribute (`id`, `text`, `source_doc`, `source_kind`, `heading_path`, `pattern_id`, `embedding <384-> for bge-small-en-v1.5, `token_count`); WS3's chunk_id scheme is `pc_####`.
2. `Case`/`ClosedCase` memory vertices carrying the closed-case fields WS3 fingerprints: `case_id`, `customer_id`, `card_id`, `connected_card_ids`, `pattern`, `outcome`, `exposure_usd`, `opened_at`, `closed_at`, `visible_from`, `summary_text`, `analyst_notes`, `fingerprint` (JSON), `embedding`.
3. Edges: `PolicyChunk -DESCRIBES-> Pattern`, `Pattern -REQUIRES_EVIDENCE-> EvidenceType`, `Case -SIMILAR_TO-> Case`, `Case -ABOUT-> (Transaction|Card|Customer|Identity)`, `Case -MATCHES_PATTERN-> Pattern`.
4. A `vectorSearch()` installed query (or MCP tool) that returns cosine top-k over a given vertex+attribute with a `pattern_id`/`visible_from <= as_of` filter, and a GSQL/MCP way to read `required_evidence`/`permitted_actions` from `Pattern` endpoints at query time.
5. Record the real MCP tool names in `docs/MCP_TOOLS.md` so WS3's runtime can call them.

Why: PRD §11's hybrid retrieval step 2 ("GSQL expansion from seed chunks to patterns, required evidence, permitted actions, linked prior cases") and the graph side of "memory write visible in graph" (DoD) both require WS1's loaded schema. WS3's adapter keeps the mocked behavior, including the vector-store `as_of` visibility rule, bit-identical so the swap is mechanical.

Blocking: no for WS3 standalone (local adapter is complete and tested); yes for the graph-native RAG/memory write-back rows of WS3's DoD.
Resolved: (leave blank until actioned)
