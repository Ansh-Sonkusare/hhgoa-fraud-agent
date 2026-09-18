# CLAUDE.md

- Read `PRD.md` sections 0, 6, 8, and your workstream's row in section 16 before writing any code.
- Own only your workstream's directory (PRD §6). If you need something in another directory, write the request in `docs/REQUESTS.md` and stop — do not edit it yourself.
- Code against `contracts/` and its fakes, not against another workstream's unfinished code. `contracts/` is FROZEN after milestone M0; changing it after that needs an explicit human OK.
- The dataset `README.md` is authoritative for files, columns, patterns, policy, and the answer format. `docs/DATA_MAP.md` is the reconciled reference — read it, don't re-derive from the CSVs. Never invent a field that isn't in one of these two.
- The answer-file shape is **exactly** the one in README.md's "Answer Format" section, reproduced in PRD.md §13. There is no separate internal answer shape — do not reintroduce one.
- Every graph, RAG, and memory tool takes `as_of` and must ignore anything after it (PRD §8.1). This is tested; don't skip it to save time.
- Stack: **TypeScript end to end, no Python.** Node 20+, npm workspaces, `tsx` to run files directly (no build step in dev), `zod` for validation, `vitest` for tests. Strict mode, no `any` without a comment saying why. The one non-TS language is `.gsql` files (TigerGraph's query language) — unavoidable, not general-purpose code.
- Tests go in `tests/<your-workstream>/` only.
- Commands: `make test`, `make lint`, `make verify-graph`, `make run-case CASE=<id>`, `make run-all`, `make validate-answers`.
- Secrets only via `.env`. Never commit raw data (`data/` is gitignored) or the dataset CSVs at repo root beyond what's already tracked.
- Finish by running your workstream's definition-of-done checks (PRD §16) and summarizing what passed, not what you attempted.
