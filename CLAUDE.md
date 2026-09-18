# CLAUDE.md

## Agent Roles

Claude Code implements this project directly for now: reasoning, planning, editing files, running commands, and verification are all done by Claude Code itself.

OpenCode delegation is planned but not active yet — it will be reintroduced later. Until then, do not delegate implementation work to OpenCode; do it directly.

## Before Writing Code

* Read `PRD.md` sections 0, 6, 8, and your workstream's row in section 16 before writing any code.
* Understand your assigned workstream and its definition of done before implementation.
* Code against `contracts/` and its fakes, not against another workstream's unfinished code.
* `contracts/` is **FROZEN after milestone M0**. Changing it after that requires explicit human approval.

## Workstream Boundaries

* Own only your workstream's directory (PRD §6).
* If something outside your workstream is required, write the request in `docs/REQUESTS.md` and stop.
* Do not edit another workstream's directory yourself.
* Do not bypass workstream boundaries by modifying shared or unfinished implementation code.

## Dataset and Answer Format

* The dataset `README.md` is authoritative for files, columns, patterns, policy, and answer format.
* `docs/DATA_MAP.md` is the reconciled reference. Read it; do not re-derive information from the CSVs.
* Never invent a field that does not exist in either `README.md` or `docs/DATA_MAP.md`.
* The answer-file shape is **exactly** the one specified in `README.md`'s "Answer Format" section and reproduced in PRD §13.
* There is no separate internal answer shape. Do not introduce one.

## Temporal Correctness

* Every graph, RAG, and memory tool takes `as_of`.
* Every such tool must ignore information after `as_of` as required by PRD §8.1.
* This behavior is tested and must not be skipped or simplified.

## Stack

* TypeScript end to end.
* No Python.
* Node 20+.
* pnpm workspaces, orchestrated with Turborepo.
* `tsx` for running files directly during development.
* No build step required for development.
* `zod` for validation.
* `vitest` for tests.
* Strict TypeScript mode.
* No `any` unless there is a code comment explaining why it is necessary.
* `.gsql` files are allowed because TigerGraph requires its query language. Do not introduce other general-purpose languages.

## Tests

* Tests go in `tests/<your-workstream>/` only.
* Do not place tests in another workstream's test directory.

## Required Commands

Use the repository's standard commands:

```bash
make test
make lint
make verify-graph
make run-case CASE=<id>
make run-all
make validate-answers
```

Run the commands relevant to the current workstream and definition of done.

## Secrets and Data

* Secrets must only be provided through `.env`.
* Never commit secrets or raw credentials.
* Never commit raw data.
* `data/` is gitignored.
* Do not add dataset CSVs to the repository root beyond files that are already tracked.

## Implementation Workflow

For substantial implementation tasks:

1. Read the required PRD sections and relevant documentation.
2. Inspect the existing implementation and contracts.
3. Identify the affected files within the assigned workstream.
4. Produce a concrete implementation plan.
5. Implement the plan directly: edit files, run commands, run tests/linting/builds/verification, fix errors.
6. Run the workstream's definition-of-done checks.
7. Only report the task as complete after the required checks pass.

Do not claim a check passed unless it was actually run and passed.

## Completion

Finish by running the workstream's definition-of-done checks from PRD §16.

Final reports must summarize:

* What was implemented.
* What files changed.
* What verification was run.
* What passed.
* Any remaining issues or blockers.

Report what actually passed, not what was attempted.

