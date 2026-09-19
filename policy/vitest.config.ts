import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws5/**/*.test.ts"],
  },
});
