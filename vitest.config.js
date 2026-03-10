import { defineConfig } from "vitest/config";

const ciExcludes = process.env.CI ? ["**/e2e-*.test.js"] : [];

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/.wt/**",
      ...ciExcludes,
    ],
  },
});
