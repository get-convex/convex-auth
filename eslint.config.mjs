import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import convexPlugin from "@convex-dev/eslint-plugin";
import importX from "eslint-plugin-import-x";

const convexRecommended = convexPlugin.configs.recommended[0].rules;

export default defineConfig([
  {
    ignores: [
      "**/_generated/**",
      // Generated data files, for example the list of frequent passwords.
      "**/*.generated.ts",
      "**/node_modules/**",
      "**/dist/**",
      ".agents/**",
      ".context/**",
      ".pnpm-store/**",
      "packages/argon2id-wasm/rust/pkg/**",
      // Generated wasm-bindgen output.
      "packages/argon2id/src/argon2-wasm/pkg/**",
      // Generated output in the docs package (Next.js build + Fumadocs MDX).
      "packages/docs/.next/**",
      "packages/docs/.source/**",
      // Generated Next.js output in the examples.
      "examples/**/.next/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.config.ts",
            "packages/*/vitest.config.ts",
            "examples/*/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: [
      "**/convex/**/*.{js,ts}",
      "packages/*/src/components/**/*.ts",
      "packages/*/src/component/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    plugins: {
      "@convex-dev": convexPlugin,
    },
    rules: convexRecommended,
  },
  {
    // The publishable packages compile to `dist/` with `tsc`, which copies
    // module specifiers through verbatim. An extensionless relative import
    // therefore stays extensionless in the published JavaScript, where Node's
    // ESM resolver rejects it — which breaks consumers whose bundler doesn't
    // paper over it (Vitest externalizes `node_modules` and loads them with
    // native ESM). Write the extension the emitted file will need: `.js`, even
    // though the source file is `.ts`.
    files: [
      "packages/core/src/**/*.{ts,tsx}",
      "packages/argon2id-wasm/src/**/*.ts",
    ],
    plugins: {
      "import-x": importX,
    },
    rules: {
      "import-x/extensions": ["error", "ignorePackages"],
    },
  },
]);
