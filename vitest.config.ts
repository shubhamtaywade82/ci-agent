import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    // Hermetic: no network, no filesystem fixtures outside the repo, no timers
    // beyond what the tests themselves control.
    pool: "threads",
  },
});
