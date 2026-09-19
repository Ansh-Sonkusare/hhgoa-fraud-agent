import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws3/**/*.test.ts"],
    // Ingestion + real-model integration tests touch the filesystem, the
    // network (first-run model download) and can stream a 700MB CSV —
    // give them room. Unit tests (chunking, context budget, as_of logic)
    // are fast and don't need this.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
