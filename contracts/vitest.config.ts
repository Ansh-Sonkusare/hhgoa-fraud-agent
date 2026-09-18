import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws0/**/*.test.ts"],
  },
});
