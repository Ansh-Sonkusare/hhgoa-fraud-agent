import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws2/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
