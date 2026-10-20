import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts only wires process.env into run(); helpers.ts is test support.
      exclude: ["src/main.ts", "src/**/*.test.ts", "src/__tests__/helpers.ts"],
      reporter: ["text"],
      thresholds: { lines: 90, functions: 90 },
    },
  },
});
