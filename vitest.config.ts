import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Barrel and type-only modules contain no logic to cover.
      exclude: ["src/index.ts", "src/types.ts"],
      thresholds: { lines: 75, statements: 75, functions: 70, branches: 70 },
    },
  },
});
