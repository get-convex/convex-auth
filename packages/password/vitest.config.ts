import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Convex's bundler turns `import mod from "*.wasm"` into a `WebAssembly.Module`.
// Vitest doesn't handle `.wasm` out of the box, so mirror that behavior: read
// the file at load time and emit a module whose default export is a
// `WebAssembly.Module`, with the bytes inlined as base64 so it works in the
// edge-runtime test environment (no fs at eval time).
//
// The `.wasm` import lives in the `@convex-dev/argon2id` dependency, so that
// package is inlined below to route it through this plugin rather than being
// externalized.
function wasmModulePlugin(): Plugin {
  return {
    name: "wasm-as-webassembly-module",
    // Run before Vite's built-in `.wasm` handling, which would otherwise try to
    // ESM-resolve the module's wasm-bindgen imports (e.g. "wbg") and fail.
    enforce: "pre",
    load(id) {
      if (!id.endsWith(".wasm")) return null;
      const base64 = readFileSync(id).toString("base64");
      return `const bytes = Uint8Array.from(atob(${JSON.stringify(
        base64,
      )}), (c) => c.charCodeAt(0));
export default new WebAssembly.Module(bytes);`;
    },
  };
}

export default defineConfig({
  plugins: [wasmModulePlugin()],
  test: {
    // Convex functions run in an edge-like runtime; convex-test relies on it.
    environment: "edge-runtime",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        // convex-test loads function modules dynamically; inlining keeps that
        // resolution working under Vitest's transform pipeline. `@convex-dev/argon2id`
        // is inlined so its `.wasm` import is handled by `wasmModulePlugin`.
        inline: ["convex-test", "@convex-dev/argon2id"],
      },
    },
  },
});
