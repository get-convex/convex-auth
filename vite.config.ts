import path from "node:path";

import { defineConfig } from "vite-plus";

const convexApp = path.resolve(import.meta.dirname, "./convex");
const authSrc = path.resolve(import.meta.dirname, "./packages/auth/src");

const testProjectAliases = {
  "@convex": convexApp,
  "@convex/": `${convexApp}/`,
  "@robelest/convex-auth/test": path.join(authSrc, "test.ts"),
  "@robelest/convex-auth": authSrc,
  "@robelest/convex-auth/": `${authSrc}/`,
} as const;

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "**/_generated/**",
      "**/node_modules/**",
      ".github/**",
      "packages/auth/src/server/auth.ts",
      "packages/auth/src/server/index.ts",
      "packages/auth/src/server/implementation.ts",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  run: {
    cache: {
      scripts: true,
      tasks: true,
    },
    tasks: {
      "cache:build:convex-codegen": {
        command:
          "vp exec varlock run -- vp exec convex codegen --component-dir ./packages/auth/src/component && vp fmt packages/auth/src/component/_generated",
        cache: true,
        input: [
          "convex/**",
          "packages/auth/src/component/**",
          "packages/auth/src/server/**",
          "packages/auth/src/providers/**",
          "packages/auth/src/component/index.ts",
          "packages/auth/convex.config.ts",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:build:auth": {
        command: "vp run --filter @robelest/convex-auth build",
        cache: true,
        input: [
          "convex/**",
          "packages/auth/**",
          "scripts/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!packages/auth/dist/**",
          "!packages/auth/src/component/_generated/**",
        ],
      },
      "cache:build": {
        command: "vp run cache:build:convex-codegen && vp run cache:build:auth",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "scripts/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:check": {
        command: "vp lint && vp fmt --check .",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "tests/**",
          "scripts/**",
          "docs/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:test:unit": {
        command: "vp test --run --project convex --project node",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "tests/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:test:interop": {
        command: "vp test --run --project interop",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "tests/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:test": {
        command: "vp run cache:test:unit && vp run cache:test:interop",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "tests/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:validate": {
        command:
          "vp run typecheck:tests && vp run '@robelest/convex-auth#typecheck:consumer' && vp run '@robelest/convex-auth#check:packaging'",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "tests/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
    },
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        root: "./tests",
        resolve: {
          alias: testProjectAliases,
        },
        test: {
          name: "convex",
          include: ["**/*.test.ts"],
          exclude: ["**/node.test.ts"],
          environment: "edge-runtime",
          setupFiles: ["./vitest/setup.ts"],
          server: { deps: { inline: ["convex-test"] } },
          fileParallelism: false,
          testTimeout: 10000,
        },
      },
      {
        root: "./tests",
        resolve: {
          alias: testProjectAliases,
        },
        test: {
          name: "node",
          include: ["**/node.test.ts"],
          exclude: ["connection/**/node.test.ts", "benchmarks/**/node.test.ts"],
          environment: "node",
          setupFiles: ["./vitest/setup.ts"],
          server: { deps: { inline: ["convex-test"] } },
          fileParallelism: false,
          testTimeout: 60000,
        },
      },
      {
        root: "./tests",
        resolve: {
          alias: testProjectAliases,
        },
        test: {
          name: "interop",
          include: ["connection/**/node.test.ts", "benchmarks/**/node.test.ts"],
          environment: "node",
          globalSetup: ["./infra/docker/setup/node.ts"],
          setupFiles: ["./vitest/setup.ts"],
          server: { deps: { inline: ["convex-test"] } },
          fileParallelism: false,
          testTimeout: 120000,
          sequence: {
            groupOrder: 1,
          },
        },
      },
    ],
  },
});
