.PHONY: test lint verify-graph verify-gsql run-case run-all validate-answers test-contracts mcp-up mcp-down

mcp-up:
	docker compose up -d --build tigergraph mcp-server

mcp-down:
	docker compose stop tigergraph mcp-server

test:
	pnpm turbo run test

test-contracts:
	pnpm turbo run test --filter=@hhgoa/contracts

lint:
	pnpm turbo run lint

verify-graph:
	pnpm --filter @hhgoa/graph verify
	pnpm --filter @hhgoa/graph mcp:smoke

verify-gsql:
	pnpm --filter @hhgoa/gsql verify

run-case:
	pnpm --filter @hhgoa/eval run-case $(CASE)

run-all:
	pnpm --filter @hhgoa/eval run-benchmark

validate-answers:
	pnpm --filter @hhgoa/eval validate-answers
