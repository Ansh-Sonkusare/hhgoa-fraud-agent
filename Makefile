.PHONY: test lint verify-graph verify-gsql run-case run-all validate-answers test-contracts

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
	@echo "run-case: not implemented yet — owned by WS4/WS7 (agent/, eval/). CASE=$(CASE)"

run-all:
	@echo "run-all: not implemented yet — owned by WS7 (eval/)"

validate-answers:
	@echo "validate-answers: not implemented yet — owned by WS7 (eval/)"
