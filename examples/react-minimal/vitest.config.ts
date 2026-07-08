import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex functions run in an edge-like runtime; convex-test relies on it.
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: {
      deps: {
        // convex-test loads function modules dynamically; inlining keeps that
        // resolution working under Vitest's transform pipeline.
        inline: ["convex-test"],
      },
    },
  },
});
