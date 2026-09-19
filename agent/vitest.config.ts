import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["../tests/ws4/**/*.test.ts"],
  },
});
