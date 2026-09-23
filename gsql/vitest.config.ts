import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws2/**/*.test.ts"],
    // Whole-graph community_lookup/discovery_report calls take ~15-20s each
    // over the real 590k-txn dataset; two tests chain 2-3 of them
    // sequentially (cross-checking discovery_report against community_lookup
    // for each discovered component), so the per-call cost alone can exceed
    // a 30s test budget without any query actually hanging.
    testTimeout: 90_000,
  },
});
