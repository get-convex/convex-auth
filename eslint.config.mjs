import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import convexPlugin from "@convex-dev/eslint-plugin";

const convexRecommended = convexPlugin.configs.recommended[0].rules;

export default defineConfig([
  {
    ignores: [
      "**/_generated/**",
      "**/node_modules/**",
      "**/dist/**",
      ".agents/**",
      ".context/**",
      ".pnpm-store/**",
      "packages/argon2id/src/argon2-wasm/pkg/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts", "packages/*/*.config.ts"],
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
]);
