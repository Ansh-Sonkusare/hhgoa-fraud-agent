.PHONY: test test-contracts lint verify-graph run-case run-all validate-answers

test:
	pnpm turbo run test

test-contracts:
	pnpm --filter @hhgoa/contracts test

lint:
	pnpm turbo run lint

verify-graph:
	@echo "verify-graph: not implemented yet — owned by WS1 (graph/)"

run-case:
	@echo "run-case: not implemented yet — owned by WS4/WS7 (agent/, eval/). CASE=$(CASE)"

run-all:
	@echo "run-all: not implemented yet — owned by WS7 (eval/)"

validate-answers:
	@echo "validate-answers: not implemented yet — owned by WS7 (eval/)"
