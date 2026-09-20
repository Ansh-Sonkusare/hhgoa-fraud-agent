# PRD: Agentic Fraud Investigation Agent (TigerGraph Hackathon)

Status: v1 draft, 2026-09-19. Owner: Teak. Deadline: assumed Tue 2026-09-22 (CONFIRM). Internal submit target: Tue 16:00 IST.

---

## 0. How to use this doc (read first, Claude Code)

- This PRD is the source of truth. `contracts/` is the source of truth for interfaces. If they disagree, `contracts/` wins and the PRD gets fixed.
- Work only inside the directory your workstream owns (section 6). Never edit another workstream's directory. If you need a change there, write it in `docs/REQUESTS.md` and stop.
- `contracts/` is FROZEN after milestone M0. Changing it needs an explicit human OK.
- Code against contracts and fixtures, not against another workstream's unfinished code. Every tool has a fake implementation (section 8.6) so nobody blocks.
- The dataset README is authoritative for file names, columns, answer format and case mechanics. Anything marked **[README]** in this PRD is a placeholder to be reconciled by WS0 into `docs/DATA_MAP.md`. Do not invent fields.
- Definition of done for every workstream is in section 16. Run its acceptance commands before declaring done.

---

## 1. Summary

Build an agent that investigates card fraud on a TigerGraph knowledge graph (IEEE-CIS-derived bank dataset, ~590k transactions, ~13.5k customers, closed prior cases, bank policy). Given a trigger (risk score, customer report, analyst request), it opens a case, gathers graph and document evidence, identifies the fraud pattern, assesses risk and confidence, requests more evidence through policy-approved actions when uncertain, recommends or executes next-best actions within permissions, explains itself, and writes the case back to the graph as memory.

Output for grading: 20 benchmark case answer files, a working agent + UI, repo, 3-5 min demo, blog, social post.

### Differentiators (Innovation, 15%)
1. **Identity-resolution vertex**: derived entity key that merges cards/devices/addresses into one investigable actor, validated against closed cases.
2. **Value-of-information evidence planning**: the agent picks the evidence request that best separates its top two hypotheses per unit of customer friction, not a generic "ask the customer".
3. **Time-travel safe investigation**: every tool takes `as_of`; the agent cannot see anything after the trigger time.
4. **Graph-native case memory**: cases, findings and outcomes are graph vertices linked to entities, so similar-case retrieval = vector similarity + shared-entity overlap.
5. **Pattern miner**: community detection over the entity graph scored against closed cases to surface the undocumented patterns the dataset warns about.

## 2. Goals and non-goals

Goals: satisfy every required component, capability, deliverable in section 4; maximize Investigation accuracy (25%) and Next-best-action (25%); reproducible runs.

Non-goals: real-time streaming, production auth, real customer messaging (all actions are mock APIs), training a fraud classifier (the bank risk score is an input signal, not our model), UI polish beyond clarity.

## 3. Assumptions and open questions (default in bold; WS0 resolves from README)

| # | Question | Default assumption |
|---|---|---|
| OQ1 | Exact deadline | **Tue 2026-09-22 EOD IST — not stated in the brief PDF itself; user confirmed "3 days" on 2026-09-19. CONFIRM against the actual hackathon platform/registration page** |
| OQ2 | How are responses to evidence requests produced (dataset-provided, or we simulate)? | **Brief doesn't specify. Simulated by `EvidenceResponder` interface; use dataset-provided responses if README defines them** |
| OQ3 | Exact answer-file format | **Brief says "one answer file" per case containing: case+investigation record/evidence/findings/decisions/actions, graph write-back, SAR when policy requires it, next-best-action+approval route recorded before AND after any evidence request. Our schema in 13 implements this; reconcile field names with README** |
| OQ4 | When is a SAR required, and what format? | **Policy/regulatory docs (bundled in dataset) define it; `policy/sar.ts` renders from case record** |
| OQ5 | Savanna vs Community Edition | **Brief: both free, either works for graph+vector. Savanna at https://savanna.tgcloud.io (auto-stop/auto-start must be ON per brief), CE at https://dl.tigergraph.com as fallback** |
| OQ6 | Vector support on the TigerGraph version we get | **Native vector attributes. If unavailable, fallback in 11.4, flag to human** |
| OQ7 | Agent framework and LLM | **Brief: framework is participant's choice (LangChain/LangGraph/OpenAI Agents SDK/CrewAI/custom) — we choose custom (justified in section 5). LLM is participant's choice, "for reasoning, tool selection, evidence synthesis, explanations — not replacing graph analysis" — we use a local Ollama model (free, no API key, Docker-hosted; see `docs/decisions.md`) via its OpenAI-compatible HTTP API, `LLM_BACKEND=ollama` in `.env`; local embeddings via `@xenova/transformers` running `bge-small-en-v1.5` in Node, no key needed** |
| OQ8 | Does data contain money-movement / counterparty fields? | **Brief: IEEE-CIS Vesta card-transaction data, every original row/column kept, ~590k txns, ~13.5k customers, "plus device and connection records for online transactions." No money-movement/counterparty fields implied. Do not fabricate merchant/counterparty vertices unless README lists them** |
| OQ9 | Team | **Solo human reviewer + parallel Claude Code sessions** |
| OQ10 | Dataset access | **Brief links a dataset named "HHGOA_IEEE" (Google Drive icon, no resolvable URL in the PDF). User must share the actual dataset link/folder before WS0 can start — this blocks everything** |
| OQ11 | Risk score / labels | **Brief confirms: every transaction has a bank risk score; there is NO "isFraud" flag anywhere. Confirms our no-leakage design (9.3, 15) is required, not optional** |
| OQ12 | Undocumented patterns | **Brief explicitly states not every fraud pattern in the data is documented — this is graded (J1, J5) and is why WS2's discovery pass (12) is required, not a stretch goal** |

## 4. Requirements traceability matrix

Every row must be green before submission. "Accept" is a concrete check.

### 4.1 Required components

| ID | Requirement (from brief) | Where | Workstream | Accept |
|---|---|---|---|---|
| R1 | TigerGraph Savanna/CE for graph AND vector storage/retrieval | 7, 11 | WS1, WS3 | `make verify-graph` prints vertex/edge counts and a vector-search query returns top-k chunks |
| R2 | GSQL + graph algorithms for traversal, pattern detection, relationship analysis | 12 | WS2 | >= 8 installed GSQL queries; WCC + Louvain (or equivalent) run; agent traces show them used |
| R3 | TigerGraph MCP exposes graph capabilities to the agent | 9.4 | WS1, WS4 | Every graph read in an agent trace is an MCP call (trace field `via: mcp`). Ingestion may use the TigerGraph REST API / `gsql` CLI directly |
| R4 | GraphRAG: pass relevant connected context to the LLM, not raw data | 11 | WS3, WS4 | `context_bundle` (curated, <= 6k tokens) logged per LLM call; no raw row dumps in prompts |
| R5 | UI showing investigation, case progression, evidence, uncertainty, recommendations, next actions | 14 | WS6 | Case page has all six panels populated from a real run |

### 4.2 Agent capabilities (brief items 1-10) and core flow (steps 1-8)

| ID | Capability | Where | Workstream | Accept |
|---|---|---|---|---|
| C1 | Investigate on 3 trigger types: risk signal, customer report, analyst request | 9.1 | WS4, WS6 | Trigger form + API accept all 3; each yields a case |
| C2 | Gather evidence from: graph, txn history, device/identity, account behavior, prior cases, external sources | 9.4, 12 | WS2, WS3, WS4 | Evidence items tagged with category (9.3) covering all 6; external = `lookup_external` (mock/static enrichment) |
| C3 | Identify pattern, likely fraud type, risk level | 9.3, 12 | WS2, WS4 | Assessment has ranked hypotheses + risk level per case |
| C4 | Create and progress case: add evidence/findings, update status/risk/recommendations, keep decision log | 10.2 | WS4, WS5 | Case event log shows >= create, evidence-added, assessment-updated, action-recorded; case exists as graph vertices |
| C5 | Case memory: store findings/decisions/actions/outcomes; retrieve similar; use outcomes; find recurring entities/patterns; update on resolve | 11 | WS3, WS4 | Similar-case panel populated; later benchmark case cites an earlier one; memory write verified in graph |
| C6 | Controlled evidence gathering: validate txn with owner, step-up auth, request info from analyst/approved party | 10.3 | WS5 | `request_evidence` only succeeds through policy engine; all 3 types implemented (mock) |
| C7 | Next actions: allow/block txn, block/monitor account, warn customer, create case, file report, request evidence, escalate | 10.1 | WS5 | All 7 action types in policy YAML and exercised across the 20 cases |
| C8 | Policies, permissions, approvals; only authorized actions executed; some need human approval | 10 | WS5 | Test: agent attempts a forbidden action -> DENIED; approval-required -> PENDING_APPROVAL; UI approve -> EXECUTED |
| C9 | Stop when evidence is enough for a defensible action | 9.5 | WS4 | Every case log has a `stop_reason` with the rule that fired |
| C10 | Explain: evidence used, why more evidence requested, why actions chosen | 9.6 | WS4, WS6 | Explanation object has 3 required sections; rendered in UI |
| F1-F8 | Trigger, Investigate, Gather, Assess uncertainty, Gather more, Act, Explain, Update memory | 9.2 | WS4 | State machine states map 1:1 (9.2); trace shows each visited |

### 4.3 Submission deliverables

| ID | Deliverable | Where | Workstream | Accept |
|---|---|---|---|---|
| D1 | Working agent | all | all | `make run-case CASE=<id>` works from a clean clone with `.env` |
| D2 | GitHub repo | all | WS8 | README with setup, architecture, how to run; no secrets/raw data |
| D3 | 20 answer files per the README's Answer Format (case, evidence, similar prior cases, SAR when required, `next_best_actions.initial`/`final` + approval route, both recorded) | 13 | WS7 | `make validate-answers` passes JSON-schema + checks: 20 files in `cases/`, graph case vertex exists for each where `written_to_graph` is true, `next_best_actions.final` present and equal to `initial` when no evidence was requested, `sar.file` agrees with `FILE_REPORT` presence |
| D4 | 3-5 min demo video | 17 | WS8 | Follows script in `submission/demo_script.md` |
| D5 | Blog: what/architecture/how TigerGraph used/agentic capabilities/learned/improve | 17 | WS8 | All 6 headings present |
| D6 | X/LinkedIn post, tags @TigerGraphDB, links blog or demo | 17 | WS8 | Draft in `submission/social.md` |

### 4.4 Judging criteria to feature map

| ID | Criterion (weight) | What earns it | Owner |
|---|---|---|---|
| J1 | Investigation accuracy (25%) | Documented + discovered pattern detectors, identity resolution, backtest on closed cases | WS2, WS7 |
| J2 | Next best action (25%) | Cost-aware decision matrix, VOI evidence planning, updated recommendation after evidence, ambiguity handling | WS4, WS5 |
| J3 | Case summary and explainability (10%) | Case timeline, evidence-linked explanation, uncertainty panel | WS4, WS6 |
| J4 | Agentic design and engineering (15%) | State machine, tool registry, policy gate, budgets, memory, tests, traces | WS4, WS5 |
| J5 | Innovation (15%) | Section 1 differentiators shown in demo and blog | all |
| J6 | Demo quality (10%) | 3 scripted cases: clear fraud, ambiguous -> evidence -> resolved, false positive cleared | WS8 |

---

## 5. Architecture

```
            Trigger (risk alert | customer report | analyst request)
                                   |
                            [ Fastify  api/ ]  <----SSE events----> [ Next.js  ui/ ]
                                   |
                        [ Agent core  agent/ ]  state machine + LLM
                          |        |        |
             +------------+        |        +-------------+
             |                     |                      |
   [ MCP client ]          [ RAG / memory  rag/ ]   [ Policy engine  policy/ ]
             |                     |                      |  gate + evidence responder
   [ TigerGraph MCP server ]       |                      |  + approvals (UI | Discord)
             |                     |                      |  + mock action APIs, SAR
             +----------+----------+                      |
                        v                                 |
            [ TigerGraph Savanna: graph + vector ]  <-----+  (case write-back)
              GSQL queries (gsql/), algos, loaders (graph/)
              raw wide columns: DuckDB (data/), accessed via a tool
```

Stack — **TypeScript end to end, no Python anywhere**: Node.js 20+, pnpm workspaces monorepo orchestrated with Turborepo, `tsx` to run TS directly (no build step during dev). Ingestion/admin against TigerGraph via its REST API and the `gsql` CLI (both language-agnostic — no pyTigerGraph needed). Agent-side MCP client: `@modelcontextprotocol/sdk` (official TS SDK). LLM: local Ollama (Docker-hosted, OpenAI-compatible HTTP API, no key) — see `docs/decisions.md` for why this replaced Claude/`@anthropic-ai/sdk`. Validation: `zod` (the TS equivalent of pydantic). API: Fastify (small, fast, native SSE support). Wide-column lookups: `duckdb` npm package (official Node bindings — same DuckDB, just called from TS). Embeddings: `@xenova/transformers` (`transformers.js`) running a small model fully locally in Node — no Python, no extra API key. UI: Next.js + TypeScript + Tailwind, react-force-graph.
The two non-TypeScript exceptions in this project are GSQL itself (`.gsql` files) — TigerGraph's own query language, unavoidable regardless of stack — and Python, allowed specifically for installing/running the official TigerGraph MCP server (`tigergraph-mcp`, a required hackathon component: https://github.com/tigergraph/tigergraph-mcp#installation), isolated to its own directory rather than mixed into application logic. See `docs/decisions.md`.

Agent framework: custom state machine (no LangChain/LangGraph). Reason: full control of budgets, policy gate and checkpoints, which are graded.

## 6. Repo layout and ownership

```
PRD.md  CLAUDE.md  Makefile  .env.example  package.json  tsconfig.base.json
contracts/     WS0   frozen after M0: zod schemas, TS types, tool specs, examples/
docs/          WS0   DATA_MAP.md, MCP_TOOLS.md, REQUESTS.md (cross-workstream asks)
fixtures/      WS0   sample tool outputs + 2 recorded case runs (for UI/agent development)
graph/         WS1   schema.gsql, loadingJobs/, scripts/load.ts, scripts/verify.ts
gsql/          WS2   queries/*.gsql, install.ts, detectors/, discovery/
rag/           WS3   ingestPolicy.ts, ingestCases.ts, retrieve.ts, contextBuilder.ts, memory.ts
agent/         WS4   machine.ts, prompts/, llm.ts, mcpClient.ts, toolsRegistry.ts, assess.ts, explain.ts
policy/        WS5   policy.yaml, engine.ts, evidence.ts, approvals/, actionsMock.ts, sar.ts
api/           WS6   Fastify app
ui/            WS6   Next.js app
eval/          WS7   backtest.ts, runBenchmark.ts, exportAnswers.ts, validateAnswers.ts, metrics.ts
cases/         WS7   output: <case_id>.json (20 files, per README Answer Format)
submission/    WS8   demo_script.md, blog.md, social.md
tests/         each WS adds tests/<ws>/ only (vitest)
data/          gitignored raw dataset
```
Each directory (`graph/`, `gsql/`, `rag/`, `agent/`, `policy/`, `api/`, `eval/`) is its own pnpm workspace package with its own `package.json`, listed in root `pnpm-workspace.yaml` and wired into `turbo.json`'s task graph, so `pnpm install` once at the top sets everything up.

## 7. Graph data model (WS1 owns; refine from README)

Vertices
- `Customer` (id, attrs **[README]**)
- `Card` (id derived from card1..card6; card_type, network, bank attrs)
- `Identity` (uid): derived actor key, heuristic, e.g. hash(card1, addr1, first-transaction-day estimated from TransactionDT - D1). Validate: measure purity against closed-case entities before trusting it. Keep raw card/device vertices too.
- `Transaction` (TransactionID, ts, amount, product_cd, risk_score, is_online, key behavior fields: dist, C*/D* summary, M* flags; the rest of V*/id_* stay in DuckDB)
- `Device` (hash of DeviceInfo + id_30 + id_31 + id_33; device_type)
- `EmailDomain` (purchaser/recipient domain)
- `Address` (addr1, addr2 region codes)
- `Case` (id, status, risk_level, confidence, fraud_type, outcome, created_at, resolved_at, embedding)
- `Finding` (id, category, text, score), `Action` (id, type, status, approval_route), `Decision` (id, text, actor), `EvidenceItem` (id, category, summary, source)
- `Pattern` (id, name, kind: documented|discovered), `PolicyChunk` (id, text, source_doc, embedding), `EvidenceType`

Edges
- `OWNS` Customer->Card; `MADE` Card->Transaction; `USED_DEVICE`, `BILLED_TO`, `PURCHASER_EMAIL`, `RECIPIENT_EMAIL` Transaction->(Device|Address|EmailDomain); `RESOLVES_TO` Card->Identity
- Aggregate (precomputed, for algorithms): `CARD_DEVICE(n, first_ts, last_ts)`, `CARD_ADDRESS(n)`, `CARD_EMAIL(n)`
- Memory: `ABOUT` Case->(Transaction|Card|Customer|Identity), `HAS_FINDING`, `HAS_ACTION`, `HAS_DECISION`, `HAS_EVIDENCE`, `MATCHES_PATTERN`, `SIMILAR_TO`, `CITES_CHUNK`, `DESCRIBES` (PolicyChunk->Pattern), `REQUIRES_EVIDENCE` (Pattern->EvidenceType)
- Closed prior cases from the first 4 months are loaded as `Case` vertices with outcome (confirmed | cleared). Benchmark cases are NOT loaded with outcomes.

Rule: every time-bearing vertex/edge carries a timestamp so `as_of` filtering works.

## 8. Contracts (WS0 writes, frozen at M0)

### 8.1 The `as_of` rule
Every graph, RAG and memory tool takes `as_of: datetime`. The runner sets it to the case trigger time. Tools must ignore transactions, cases and outcomes after `as_of`. Eval fails the run if any returned item is later than `as_of` (`tests/test_no_leak.ts`).

### 8.2 Tool result envelope (all tools)
```json
{ "ok": true, "tool": "get_neighborhood", "as_of": "...", "via": "mcp|local|rag|policy",
  "data": {}, "evidence_refs": ["ev_..."], "truncated": false, "latency_ms": 0, "error": null }
```
Tools never return more than N rows (default 50) and always include summary stats, so LLM context stays curated (R4).

### 8.3 Evidence item
```json
{ "id": "ev_...", "category": "graph_structure|txn_behavior|device_identity|prior_cases|policy_match|external|customer_response",
  "summary": "...", "entities": [{"type":"Card","id":"..."}], "source_tool": "...", "weight_hint": 0.0,
  "supports": ["fraud_type_x"], "contradicts": [], "ts": "..." }
```

### 8.4 Tool catalog (names, args, returns; details in `contracts/tools.ts`)

Graph (executed via MCP -> installed GSQL queries):
- `resolve_trigger(trigger)` -> entities (txn, card, customer, identity)
- `get_entity_profile(entity, as_of)`
- `get_transaction_history(entity, window, as_of)` -> rows + stats
- `get_neighborhood(entity, hops<=3, filters, as_of)`
- `compute_velocity(entity, window_minutes, as_of)`
- `find_shared_entity_rings(entity, as_of)` -> shared device/email/address groups + community id
- `get_baseline_deviation(txn, as_of)` -> amount/geo/device/time z-scores vs customer baseline
- `detect_patterns(entity_or_txn, as_of)` -> [{pattern_id, score, evidence}] for documented + discovered
- `get_community(entity, as_of)` -> precomputed WCC/Louvain community stats
- `find_prior_cases(entity, as_of)`
- `get_wide_features(txn_ids)` -> DuckDB lookup (V*/id_* columns), local

RAG / memory:
- `retrieve_policy(query, pattern_id?, k)` -> chunks + linked patterns/required evidence/permitted actions
- `retrieve_similar_cases(fingerprint, as_of, k)` -> cases with outcomes and overlap explanation
- `lookup_external(kind: email_domain|ip|geo, value)` -> static/mock enrichment (labelled external)

Case:
- `case_open`, `case_add_evidence`, `case_add_finding`, `case_update_assessment`, `case_record_decision`, `case_record_action`, `case_set_status`, `case_close` (each appends to the event log and writes graph)

Policy / action:
- `policy_check(action_or_request, case_state)` -> `{allowed, approval_route, missing_prerequisites, sar_required}`
- `execute_action(action, params)` -> `EXECUTED | PENDING_APPROVAL | DENIED` (only through policy engine)
- `request_evidence(type, target, reason)` -> policy check -> approval if needed -> responder -> `EvidenceResponse`
- `generate_sar(case)`

### 8.5 Other contracts
- `Assessment`, `Checkpoint`, `CaseRecord`, `AnswerFile` zod schemas + inferred TS types (sections 9.3, 13)
- `policy.schema.json` (section 10)
- `AgentEvent` for SSE: `{seq, ts, case_id, type, state, payload}` where type in `state_entered|tool_call|tool_result|evidence_added|assessment_updated|evidence_requested|approval_requested|action_result|explanation|memory_written|done|error`
- `EvidenceResponder` and `ApprovalChannel` interfaces (section 10.4)

### 8.6 Fakes
`contracts/fakes.ts` provides in-memory implementations of every tool returning `contracts/examples/*.json`. WS4/WS5/WS6/WS7 build and test against fakes until real tools land. Switch by env `TOOLS_BACKEND=fake|real`.

---

## 9. Agent spec (WS4)

### 9.1 Triggers
`RiskSignal{txn_id|card_id, risk_score}`, `CustomerReport{customer_id, txn_ids?, text}`, `AnalystRequest{entity, question}`. The benchmark provides cases in a README-defined form; the runner adapts them to one of these.

### 9.2 State machine
```
TRIGGERED -> CASE_OPENED -> INVESTIGATING <-----------------------------+
                                |                                        |
                             ASSESSING                                   |
                       sufficient? --yes--> DECIDING                     |
                                |no                                      |
                        EVIDENCE_PLANNING -> policy_check                |
                                |                                        |
                     [CHECKPOINT 1 written] AWAITING_EVIDENCE            |
                                |                                        |
                        EVIDENCE_RECEIVED -------------------------------+
DECIDING -> APPROVAL_ROUTING -> [CHECKPOINT 2 / final written] -> EXPLAINING -> MEMORY_UPDATE -> DONE
```
Maps to brief flow: Trigger=TRIGGERED, Investigate=CASE_OPENED/INVESTIGATING, Gather evidence=INVESTIGATING, Assess uncertainty=ASSESSING, Gather more=EVIDENCE_PLANNING..RECEIVED, Take actions=DECIDING/APPROVAL_ROUTING, Explain=EXPLAINING, Update memory=MEMORY_UPDATE.

Budgets (env-tunable): `MAX_TOOL_CALLS=25`, `MAX_EVIDENCE_ROUNDS=2`, `MAX_INVESTIGATE_LOOPS=4`. Exhaustion triggers the stop rule (9.5), never a silent stop.

### 9.3 Assessment (structured, validated in code)
```json
{ "hypotheses": [{"fraud_type": "...", "probability": 0.0, "supporting": ["ev_"], "contradicting": ["ev_"]}],
  "risk_level": "LOW|MEDIUM|HIGH|CRITICAL", "risk_score": 0,
  "confidence": 0.0,
  "sufficiency": {"sufficient": false, "missing": [{"what":"","why":"","would_change_decision":true}], "stop_reason": null},
  "legit_hypothesis_probability": 0.0 }
```
Always include a "legitimate activity" hypothesis. Bank `risk_score` from the dataset is one evidence item, not the answer.

Confidence guard (code, not LLM): cap confidence by evidence diversity: <2 categories -> <= 0.45; 2 -> <= 0.65; >= 3 independent categories -> uncapped. Contradicting evidence with weight above threshold lowers the cap by one tier. LLM proposes; `assess.ts` enforces.

### 9.4 Tool use and MCP
`agent/mcpClient.ts` connects to TigerGraph MCP; graph tools in the registry are thin wrappers that call MCP tools (installed-query runner, etc.). WS1 records the real MCP tool names in `docs/MCP_TOOLS.md`. The registry validates args, injects `as_of`, wraps results into the envelope, and logs every call.

### 9.5 Stop rule (defensible action)
Stop investigating and decide when ALL hold:
1. `>= 3` evidence categories consulted (or all available ones exhausted),
2. top hypothesis leads the runner-up (including "legitimate") by margin >= 0.25 OR `confidence >= 0.75`,
3. prerequisites for the intended action are satisfied per `policy_check`.

Also stop when budgets are exhausted or no permitted evidence request would change the decision. Then: escalate to analyst with the uncertainty summary. `stop_reason` is one of `sufficient_evidence | budget_exhausted | no_discriminating_evidence_available | policy_requires_human`.

### 9.6 Evidence planning (VOI) and explanation
Evidence planning: for each permitted evidence request in policy, score `discrimination(top2 hypotheses) / friction_cost`. Prefer the highest score; log the scored alternatives. The rationale says which hypotheses the request separates.

Explanation object (mandatory sections): `evidence_used[]` (ids + one line each), `why_more_evidence` (or null), `why_actions` (per action), `remaining_uncertainty`, `what_would_change_the_decision`. Every sentence cites `ev_` ids where it makes a factual claim.

### 9.7 Default next-best-action matrix (policy YAML overrides)
| Situation | Recommendation |
|---|---|
| High/critical risk, confidence >= 0.75 | block txn and/or account (route per policy), create/escalate case, SAR if policy requires |
| Medium risk or confidence 0.4-0.75 | request cheapest discriminating evidence (validate txn / step-up), monitor account meanwhile |
| Low risk, confidence >= 0.7 | allow, close case with rationale |
| Evidence exhausted, still ambiguous | escalate to fraud analyst with uncertainty summary |
Cost-awareness: wrongly blocking a legitimate customer and wrongly allowing fraud have policy-defined costs; use them in tie-breaks.

### 9.8 Prompts
`agent/prompts/` holds system prompt, planner, assessor, evidence-planner, explainer. Rules: temperature 0; structured output validated by zod with one repair retry; prompts receive only the curated `context_bundle`; all LLM calls logged to `runs/<run_id>/llm/`.

---

## 10. Policy, permissions, approvals (WS5)

### 10.1 `policy/policy.yaml` (values from the bank policy **[README]**)
```yaml
actions:
  allow_transaction:   {executable_by_agent: true,  approval_route: none}
  block_transaction:   {executable_by_agent: false, approval_route: analyst,
                        prerequisites: {min_risk: HIGH, min_evidence_categories: 3}}
  block_account:       {executable_by_agent: false, approval_route: senior_analyst}
  monitor_account:     {executable_by_agent: true,  approval_route: none}
  warn_customer:       {executable_by_agent: true,  approval_route: none}
  create_case:         {executable_by_agent: true,  approval_route: none}
  file_report:         {executable_by_agent: false, approval_route: compliance}
  escalate_to_analyst: {executable_by_agent: true,  approval_route: none}
evidence_requests:
  validate_transaction_with_owner: {friction_cost: 2, approval_route: none}
  step_up_authentication:          {friction_cost: 3, approval_route: none}
  request_info_from_analyst:       {friction_cost: 1, approval_route: none}
sar: {required_if: "..."}   # from regulatory references
```
The above is a template. Real routes, thresholds, roles come from the policy document.

### 10.2 Case lifecycle
Statuses: `OPEN -> INVESTIGATING -> AWAITING_EVIDENCE -> PENDING_APPROVAL -> ACTIONED -> CLOSED` (also `ESCALATED`). Every transition and decision is an event in the case log and written to the graph.

### 10.3 Evidence gathering
`request_evidence`: policy_check -> (approval if route != none) -> `EvidenceResponder.respond(request)` -> `EvidenceResponse` added as evidence category `customer_response`. Checkpoint 1 is written BEFORE the request is sent; checkpoint 2 AFTER the response is processed.

### 10.4 Interfaces
- `EvidenceResponder`: `DatasetResponder` (if README supplies responses) and `SimulatedResponder` (deterministic, seeded, documented; must not use hidden labels).
- `ApprovalChannel`: `UIApprovalChannel` (default; approve/reject in UI) and optional `DiscordApprovalChannel` (webhook post + reply capture; optional Hermes gateway). Discord is a nice-to-have, never on the critical path.
- Mock action APIs in `actionsMock.ts` (freeze, block, message, CRM update) write an action log; no real side effects.

### 10.5 Hard guarantees (tests required)
- `execute_action` is the only path to side effects and always goes through `policy_check`.
- Actions with `executable_by_agent: false` can only reach `PENDING_APPROVAL`.
- Missing prerequisites -> `DENIED` with reason surfaced in explanation.

---

## 11. GraphRAG and case memory (WS3)

Documents: bank fraud policy, the 5 known patterns, regulatory references. Chunk by heading/section (~300-500 tokens), store as `PolicyChunk` with embedding; link `DESCRIBES` to `Pattern`, and `Pattern -REQUIRES_EVIDENCE-> EvidenceType`.

Retrieval = hybrid: (1) vector top-k seeds, (2) GSQL expansion from seed chunks to patterns, required evidence, permitted actions, linked prior cases, (3) `context_builder` ranks and trims into a `context_bundle` (<= 6k tokens) with provenance ids. The LLM sees the bundle, not raw rows.

Case memory:
- Load the closed cases (first 4 months) with fingerprint = {pattern, key entity ids/types, amounts band, device/address signals, outcome} and summary embedding.
- `retrieve_similar_cases` score = cosine(summary) + entity-overlap (shared card/device/address/identity/community) with `as_of` filtering; returns outcome and why similar.
- Recurring entities: `memory.ts` exposes entity-level stats (prior case count, confirmed-fraud count) via `find_prior_cases`.
- Write path (`memory.ts`): on MEMORY_UPDATE create/refresh `Case` + `Finding/Action/Decision/EvidenceItem` vertices, `ABOUT`/`MATCHES_PATTERN`/`SIMILAR_TO` edges, embed the case summary. Benchmark cases run in chronological order so later cases can retrieve earlier ones.
- Fallback (OQ6): if native vectors are unavailable, use a local index keyed by vertex id and flag it in the blog. Timebox 2h before falling back.

## 12. Graph analytics (WS2)

Installed queries (minimum 8): neighborhood, velocity, shared-entity rings, baseline deviation, transaction history, prior cases, pattern detectors, community lookup.
Algorithms: WCC and Louvain over the Card-Device-Email-Address projection; degree/PageRank for hub devices; shortest path between flagged entities; k-hop expansion. If the GDS library is unavailable on the instance, write WCC/label propagation in GSQL.
Pattern detectors: one per documented pattern (5) in `gsql/detectors/`, each returning `{score, evidence_rows}` with `as_of`.
Discovery (`gsql/discovery/`): community-level stats (size, velocity, shared-device density, risk-score distribution) joined with closed-case outcomes; top communities with high confirmed-fraud rate but no matching documented detector become `discovered` patterns (written to `Pattern` with description). Cap at 3 hours; hardcode what works.
Identity vertex validation: report purity/merge rate on closed cases in `docs/IDENTITY_VALIDATION.md`.

## 13. Answer file spec (WS7; binding, matches README exactly — no internal variant)

**The README's "Answer Format" section is the only schema. This is not a paraphrase — `contracts/answerFile.ts` (zod) is generated directly from it, and `eval/exportAnswers.ts` must produce exactly this shape, field for field.** An earlier draft of this PRD proposed a different internal shape (`checkpoints[]`, `hypotheses_history`, `explanation`, `final_status`) that is retired. `investigation_record` is back — not as a new top-level invention but because the submission brief requires the internal investigation record in the answer file: it is the agent's own `AgentEvent` stream (PRD §8.5) in `seq` order, embedded verbatim so a grader can reconstruct what the agent did and why. It must be non-empty.

One JSON per case at `cases/<case_id>.json` (folder name and filename per README, not `answers/case_<id>.json`):

```json
{
  "case_id": "",
  "case": {
    "status": "open|closed_fraud|closed_legitimate|escalated",
    "verdict": "fraud|legitimate|uncertain",
    "fraud_probability": 0.0,
    "pattern": "card_testing|card_not_present_fraud|card_not_present_new_device|out_of_region_use|account_takeover|undocumented|none",
    "pattern_description": "",
    "affected_txn_ids": [],
    "first_suspicious_txn_id": "",
    "connected_card_ids": [],
    "connected_device_profiles": [],
    "exposure_usd": 0.0,
    "evidence": [{"claim":"","source":"graph|document|customer|external","ref":"","entity_ids":[]}],
    "similar_prior_cases": [],
    "summary": "",
    "written_to_graph": false,
    "graph_case_id": ""
  },
  "evidence_requests": [{"type":"customer_validation|step_up_auth|analyst_info","asked_after_step":0,"assumed_response":""}],
  "next_best_actions": {
    "initial": [{"action":"","route":"auto|L1|L2","reason":""}],
    "final": [{"action":"","route":"auto|L1|L2","reason":""}],
    "what_changed": ""
  },
  "sar": {
    "file": false,
    "reason": "",
    "narrative": "",
    "subjects": [],
    "total_amount_usd": 0.0,
    "activity_dates": []
  },
  "investigation_record": [
    {"seq":0,"ts":"","case_id":"","type":"state_entered|tool_call|tool_result|evidence_added|assessment_updated|evidence_requested|approval_requested|action_result|explanation|memory_written|done|error","state":"","payload":{}}
  ],
  "stop_reason": "",
  "tool_calls": 0,
  "tokens": 0,
  "latency_s": 0.0
}
```

Field-level meaning, enum values, and the worked example are in the README's Answer Format section — do not restate or drift from it here. Notes worth repeating because they're easy to violate in code:
- `case.pattern_description` is required (non-empty) only when `pattern` is `undocumented`, else `""`.
- If `verdict` is `legitimate`: `affected_txn_ids: []`, `exposure_usd: 0`, `sar.file: false`.
- `sar.file` must agree with whether `FILE_REPORT` appears in `next_best_actions.final`. If `sar.file` is false: `narrative: ""`, `subjects: []`, `total_amount_usd: 0`, `activity_dates: []`.
- `next_best_actions.final` equals `initial` (and `what_changed` is `"nothing"`) whenever `evidence_requests` is empty.
- Every ID referenced anywhere in the file must exist in the dataset; the validator checks this, not just JSON-schema shape.
- `investigation_record` is required and non-empty: the `AgentEvent` stream for the run, in `seq` order.

`eval/validateAnswers.ts` checks: 20 files present in `cases/`, JSON-schema conformance to the shape above, all referenced IDs resolve in the dataset, `sar.file` agrees with `FILE_REPORT` presence, `case.written_to_graph` implies a `case.graph_case_id` exists as a vertex in TigerGraph, and `investigation_record` is non-empty with strictly increasing `seq`.

## 14. UI spec (WS6)

Next.js pages; data via the Fastify API (REST + SSE `AgentEvent` stream).
1. **Case queue**: 20 benchmark cases + "new trigger" form (3 trigger types). Status, risk, confidence chips.
2. **Case detail** (main demo screen), panels:
   - Header: status, fraud type, risk, confidence
   - Live investigation timeline (events, tool calls, state transitions, pre/post evidence checkpoints)
   - Evidence panel grouped by category with entity links
   - Neighborhood graph (force graph, colored by entity type, highlighted suspicious cluster)
   - Uncertainty panel: hypotheses bar, missing evidence, "what would change the decision"
   - Recommended actions with approval state and Approve/Reject buttons (calls approval channel)
   - Similar prior cases with outcome and overlap reasons
   - Explanation and SAR (when present)
3. **Approvals inbox**.
Build against `fixtures/` first. Empty/error states required. No auth.

## 15. Evaluation (WS7)

- Backtest: hold out ~30% of closed cases (stratified by outcome/pattern); load the rest as memory; run agent with `as_of` = trigger time. Metrics: fraud-type accuracy (macro F1), decision agreement (confirmed -> block/escalate; cleared -> allow/monitor), false-block rate, evidence-request usefulness (% where post-evidence decision differs or confidence rises), avg tool calls, latency, cost.
- Leakage tests: `tests/test_no_leak.ts` (as_of), no benchmark outcomes in memory, no `isFraud`-like hidden labels used.
- Benchmark run: `make run-all` processes the 20 chronologically, writes `cases/`, then `make validate-answers`. Read every output by hand; log fixes in `eval/NOTES.md`.
- Reproducibility: temp 0, per-case tool-result cache under `.cache/`, run logs under `runs/<run_id>/`.
- Performance target: <= 3 min per case.

---

## 16. Workstreams (parallelizable)

Dependency: WS0 first (about 2 hours). Then WS1-WS6 in parallel against contracts/fakes. WS7 begins once WS4 emits real events. WS8 continuously.

| WS | Name | Owns | Depends on | Deliverables | Definition of done |
|---|---|---|---|---|---|
| WS0 | Contracts and data map | `contracts/`, `docs/`, `fixtures/`, skeleton, Makefile | README | DATA_MAP.md, all zod schemas and TS types, tool catalog, fakes, 2 fixture case runs, CLAUDE.md | `make test-contracts` passes; fakes return valid envelopes for every tool; answer schema reconciled with README |
| WS1 | Graph infra and ingestion | `graph/` | WS0 | Savanna up (auto-stop/start on), schema, loaders for txns/customers/closed cases, aggregate edges, Identity derivation, MCP server connected, MCP_TOOLS.md | `make verify-graph` passes; counts match README; 3 sample queries succeed through MCP |
| WS2 | GSQL toolkit and discovery | `gsql/` | WS1 schema (can start from schema.gsql draft) | >= 8 installed queries, 5 pattern detectors, WCC/Louvain, discovery report | Each query has a test with `as_of`; detectors return evidence rows; IDENTITY_VALIDATION.md written |
| WS3 | GraphRAG and memory | `rag/` | WS0, WS1 schema | Chunk + embed docs, pattern links, closed-case fingerprints/embeddings, hybrid retrieval, context builder, memory write path | Retrieval returns provenance-tagged bundles <= 6k tokens; similar-case test returns overlap explanation; memory write visible in graph |
| WS4 | Agent core | `agent/` | WS0 (fakes) | State machine, MCP client, tool registry, assessor with confidence guard, VOI planner, explainer, prompts, event emission | Full run on fakes emits all state events; stop-rule tests; structured output validation + repair; real-tools switch works |
| WS5 | Policy, evidence, approvals, SAR | `policy/` | WS0 | policy.yaml from bank policy, engine, responders, approval channels, mock actions, SAR generator | Section 10.5 tests pass; all 7 action types and 3 evidence types callable; SAR renders for a policy-triggering case |
| WS6 | API and UI | `api/`, `ui/` | WS0 (fixtures, AgentEvent) | Fastify + SSE, all pages in section 14 | Runs from fixtures; then from a real run; screenshots for blog |
| WS7 | Eval and export | `eval/`, `cases/` | WS4 (real events) | Backtest, batch runner, exporter, validator, metrics | `make run-all && make validate-answers` green; backtest metrics table produced |
| WS8 | Submission | `submission/`, README | continuous | Repo README, demo script, blog, social post | Section 17 checklist complete |

Recommended concurrent sessions (limit what one human can review):
- Session A: WS1 then WS2 (graph track)
- Session B: WS3
- Session C: WS4 + WS5 (agent and policy are tightly coupled)
- Session D: WS6
- Later: WS7 (start Day 2), WS8 (Day 3)

---

## 17. Timeline, milestones, submission checklist

| Day | Milestone | Exit criterion |
|---|---|---|
| Day 1 (Sat 19) | **M0** contracts frozen (about noon); **M1** graph loaded, 3 queries via MCP, agent runs end-to-end on fakes, UI renders fixture | `make verify-graph`; `TOOLS_BACKEND=fake make run-case` completes |
| Day 2 (Sun 20) | **M2** real graph tools + RAG wired, first real case end to end; **M3** policy engine, evidence loop, memory write, 5 benchmark cases | one complete answer file validates |
| Day 3 (Mon 21) | **M4** all 20 run, backtest numbers, UI on real data; **M5** demo recorded, blog drafted | `make validate-answers` green |
| Day 4 (Tue 22) | **M6** fixes, final full run, submit by 16:00 IST | all boxes below ticked |

Cut order if behind: Discord approvals -> external enrichment depth -> graph-viz polish -> discovery beyond one pass. Never cut: two checkpoints, graph write-back, policy gate, MCP usage, GraphRAG bundle, UI panels, VOI evidence planning (simple version).

Submission checklist
- [ ] R1-R5, C1-C10, D1-D6, J1-J6 rows in section 4 verified
- [ ] 20 answer files valid and each case present in the graph; SARs present where required
- [ ] Repo clean: README, `.env.example`, no secrets, no raw data; runs from clean clone
- [ ] Demo (3-5 min): clear fraud; ambiguous case -> evidence request -> updated recommendation; false positive cleared. Show approval flow and case memory retrieval
- [ ] Blog with headings: What I built / Architecture / How TigerGraph is used / Agentic capabilities / What I learned / What I'd improve (include backtest table and architecture diagram)
- [ ] Post on X or LinkedIn tagging @TigerGraphDB with blog/demo link
- [ ] Savanna instance left running/accessible as needed for judges (auto-stop on)

## 18. Risks

| Risk | Mitigation |
|---|---|
| Load time/timeouts on Savanna for 590k txns | Start load first; subsample to entities touched by closed + benchmark cases if slow |
| Vector support missing on instance | 2h timebox, then local index + disclose |
| MCP tool limits/timeouts | Prefer installed queries with LIMITs; cache; paginate server-side |
| LLM cost/latency across 20 cases x rounds | Tool-result cache, small context bundles, cheaper model for summarization |
| Label leakage in eval | `as_of` enforcement + tests; no benchmark outcomes in memory |
| Overfitting to the 20 | Tune only on backtest split |
| Unknown README details | WS0 reconciles first; placeholders marked **[README]** |
| Scope creep in UI | Build to fixtures; single case page is the demo |
| Dataset link not yet in hand (OQ10) | Nothing else can start until this arrives. Ask for it now, first message tomorrow if not tonight |
| Wrong deadline assumption (OQ1) | Confirm the actual date on the hackathon registration/platform page before Day 3 planning locks in |

### 18.1 Resources (from the brief, verify links before relying on them)
- Savanna: https://savanna.tgcloud.io · Community Edition: https://dl.tigergraph.com
- TigerGraph MCP: https://github.com/tigergraph/tigergraph-mcp
- Support: TigerGraph Discord https://discord.gg/7JMkCAy9D3 · DevRel contact Devanshu, +91 7404313376

---

## 19. Claude Code execution playbook

### 19.1 Setup
```bash
git init && git add PRD.md && git commit -m "prd"
# Session 0 (single): do WS0 -> commit -> tag m0
git tag m0
# then one worktree per parallel session
git worktree add ../wt-graph -b ws1-graph
git worktree add ../wt-rag   -b ws3-rag
git worktree add ../wt-agent -b ws4-agent
git worktree add ../wt-ui    -b ws6-ui
```
Merge order: WS0 -> WS1/WS3 -> WS2 -> WS4/WS5 -> WS6 -> WS7. Rebase onto main daily. Contract changes only on `main` via a human-approved commit.

### 19.2 `CLAUDE.md` (WS0 creates; content)
- Read PRD.md sections 0, 6, 8 and your workstream row in 16 before coding.
- Own only your directory. Requests to others go in `docs/REQUESTS.md`.
- Code against `contracts/` and fakes. Never change `contracts/` after tag m0.
- All graph/RAG/memory tools take `as_of`. Never return unbounded rows.
- Commands: `make test`, `make lint`, `make verify-graph`, `make run-case CASE=<id>`, `make run-all`, `make validate-answers`.
- TypeScript only, no Python anywhere. Node 20+, pnpm workspaces + Turborepo, `tsx` to run files directly, zod for validation, vitest for tests. Strict mode, no `any` without a comment saying why. Tests in `tests/<ws>/`.
- Secrets only via `.env`. Never commit raw data.
- Finish by running your workstream's definition-of-done checks and summarizing what passed.

### 19.3 Kickoff prompts (paste one per session, from the worktree)

WS0:
```
If the dataset (folder/zip containing the IEEE-CIS-derived transactions, closed cases, policy docs, and README) is not already present in this working directory, stop and ask for it before doing anything else. Once present: read PRD.md fully and the dataset README. This project is TypeScript only end to end (no Python) — Node 20+, pnpm workspaces + Turborepo, tsx, zod, vitest. Do WS0: write docs/DATA_MAP.md (every file/column/answer format/case mechanics), fill all [README] placeholders in PRD.md as an "Amendments" section, create contracts/ (zod schemas + TS types, tool catalog, AgentEvent, fakes, examples), fixtures/ (2 recorded case runs), root package.json + pnpm-workspace.yaml + turbo.json + tsconfig.base.json, Makefile (thin wrapper over pnpm/turbo scripts), CLAUDE.md, .env.example. Freeze and tag m0 when make test-contracts passes.
```
WS1:
```
Read PRD.md sections 0, 5, 7, 16(WS1) and contracts/. Do WS1 in graph/: provision-check Savanna, write schema.gsql and loading jobs for the dataset per docs/DATA_MAP.md, load data (start with the smallest slice to validate, then full), derive Identity + aggregate edges, connect TigerGraph MCP, record real tool names in docs/MCP_TOOLS.md, implement make verify-graph. Do not touch other directories.
```
WS2:
```
Read PRD.md sections 0, 7, 12, 16(WS2), contracts/ and docs/DATA_MAP.md. Do WS2 in gsql/: implement and install the >=8 GSQL queries (all take as_of), 5 documented-pattern detectors, WCC/Louvain, discovery report, identity validation doc. Test each query on a known closed case.
```
WS3:
```
Read PRD.md sections 0, 8, 11, 16(WS3), contracts/. Do WS3 in rag/: ingest policy/patterns/regs chunks with embeddings and pattern links, load closed cases as fingerprinted memory, hybrid retrieval, context_builder (<=6k tokens, provenance ids), memory write path. Expose exactly the contract tool signatures. Enforce as_of.
```
WS4+WS5:
```
Read PRD.md sections 0, 8, 9, 10, 16(WS4,WS5), contracts/. Build agent/ and policy/ against fakes (TOOLS_BACKEND=fake): state machine with events, MCP client wrapper, tool registry, assessor with the confidence guard and stop rule, VOI evidence planner, explainer, policy engine + responders + approval channels + mock actions + SAR. Implement the section 10.5 tests. Then switch to real tools as WS1-3 land.
```
WS6:
```
Read PRD.md sections 0, 8.5, 14, 16(WS6), contracts/ and fixtures/. Build api/ (Fastify + SSE of AgentEvent, in TypeScript) and ui/ (Next.js) for every panel in section 14 against fixtures first, then the live API.
```
WS7:
```
Read PRD.md sections 13, 15, 16(WS7). Build eval/: backtest on held-out closed cases with as_of, batch runner over the 20 benchmark cases in chronological order, exporter to cases/ (README Answer Format, exact field names), validateAnswers.ts (schema + graph presence + initial/final next_best_actions + SAR rules), metrics table.
```
WS8:
```
Read PRD.md sections 4, 17. Draft submission/demo_script.md (3 scripted cases, timed), blog.md with the six required headings, social.md, and the repo README. Fill in numbers from eval output when available.
```

### 19.4 Subagent hygiene
Use subagents inside a session for read-only exploration (DATA_MAP drafting, docs lookups), not for writing across workstream boundaries. Have a separate fresh session review each merged workstream against its definition of done and the section 4 rows before you tick them.
