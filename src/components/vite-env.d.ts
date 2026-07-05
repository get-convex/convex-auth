/**
 * The component test suites load their modules with Vite's `import.meta.glob`
 * (Vitest provides it at runtime), but the root tsconfig only pulls in `node`
 * types, so the API is declared here. Runtime-only for tests; nothing under
 * the package's export paths references this file, so it never reaches
 * consumers' compilations.
 */
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
