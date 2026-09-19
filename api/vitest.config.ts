import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws6/**/*.test.ts"],
  },
});
