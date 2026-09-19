import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws7/**/*.test.ts"],
    // WS7 validates against the real (gitignored) 700MB transactions table:
    // cold index builds take ~7s and streaming column reads several more, so
    // the default 5s testTimeout would flake on every fresh checkout.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
