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
Resolved: partially actioned in commit <COMMIT> (see caveats below — the parts that can break this TigerGraph CE 4.3.0-rc1 build are delivered; the parts that cannot are documented rather than faked).

**What was delivered**

- Items 1-2 (vertex shapes), 3 (edges): the schema-side half was already present when this request was written — `PolicyChunk(id, text, source_doc, pattern_id, embedding LIST<DOUBLE>)` and `FraudCase` with `id, status, verdict, fraud_probability, pattern, pattern_description, exposure_usd, opened_at, closed_at, outcome, summary, source, report_filed, analyst_notes, first_fraud_txn_id, n_txns, embedding`; all five requested edges exist (`DESCRIBES`, `REQUIRES_EVIDENCE`, `SIMILAR_TO`, `ABOUT`, `MATCHES_PATTERN`). See `graph/schema.gsql`.
- Item 4: `gsql/queries/vector_search.gsql` (installed `vector_search(vertex_type, query_id, k, pattern_id, as_of, apply_as_of, outcome)`): cosine top-k (unit-vector-safe true cosine, `HeapAccum`, `O(N log k)`) over `PolicyChunk` (optional exact `pattern_id`) or `FraudCase` (visible-from equivalence: `apply_as_of=true` keeps `closed_at > epoch && closed_at <= as_of`, which drops open cases — verified 192/5585 `FraudCase`s are open/epoch on the live graph; optional `outcome`).
- Item 4b: `gsql/queries/get_pattern_profile.gsql` (installed): Pattern fields + `required_evidence` via `REQUIRES_EVIDENCE`.
- Item 5: `docs/MCP_TOOLS.md` now lists both new tools.

**Caveats / what this CE build cannot do (verified empirically, not assumed)**

- *(Superseded 2026-09-23: a list param CAN be used once copied into a `ListAccum` by a top-level `FOREACH`; `vector_search` now takes `qvec` + `scores_only`, and `rag/src/store/tigergraphIndex.ts` scores policy chunks and case memory in the graph with embeddings synced by `pnpm --filter @hhgoa/rag sync-graph`. Original caveat kept below for history.)* `vector_search` reads the query vector from a seeded vertex's `embedding` ATTRIBUTE (`query_id`), not from a `LIST<DOUBLE>` query param: GSQL rejects every method call on a list parameter ("identifier ... of type list parameter is invalid to call any function"). WS3's `TigerGraphVectorStore` already owns chunk/case embeddings, so it upserts the query embedding once (its `upsert`) then searches.
- `ALTER VERTEX … ADD ATTRIBUTE` is unsupported on this build (also `CREATE GRAPH` re-runs), so the extra record fields the request lists (`source_kind`, `heading_path`, `token_count` on `PolicyChunk`; `customer_id`, `card_id`, `connected_card_ids`, `visible_from`, `summary_text`, `fingerprint` on `FraudCase`) CANNOT be added in place — they need a full `DROP ALL` + reload via `make verify-graph`, which WS1 will do with WS3 before the graph-native swap. `visible_from` is already covered as `closed_at` + the epoch rule above.
- `permitted_actions` is NOT graph-backed (no Pattern attribute stores it). WS3 keeps that mapping in `rag/src/patterns.ts` and expands it locally (`retrieve.ts`); `get_pattern_profile` is the graph half (identity + `REQUIRES_EVIDENCE`), documented rather than dropped.

Tests: `tests/ws2/vectorSearch.test.ts` (8 tests, live REST, self-upserting/cleaning synthetic rows) — run via `pnpm --filter @hhgoa/gsql verify`.
