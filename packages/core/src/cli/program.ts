/**
 * `npx @convex-dev/auth` — initialize a basic Convex Auth (v2) project.
 *
 * What it does, in order:
 *   1. Confirms `@convex-dev/auth` is a dependency of the project in the current
 *      directory. If it isn't, it crashes with the exact install command for the
 *      detected package manager (it does NOT install anything itself).
 *   2. Generates an RS256 key pair and sets the AUTH_PRIVATE_KEY / AUTH_JWKS env
 *      vars on the Convex deployment (idempotent; `--force` rotates them).
 *   3. Scaffolds `convex/auth.config.ts`, `convex/convex.config.ts` and
 *      `convex/auth.ts`. Existing files are left untouched — the CLI instead
 *      prints the content the file should contain.
 *
 * The command's behavior is expressed as a set of injectable dependencies (see
 * `defaultDeps`) so it can be driven end-to-end in unit tests with the file
 * system, key generation, and Convex env access all stubbed out.
 */

// TODO(nicolas) This is a rough draft. Ideally, we simplify the setup process
// (e.g. by skipping the need for a key pair generation + simplyfying the API)
// so that users don’t need to rely on this.

import { Command } from "commander";
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ALG = "RS256";

/** The package the generated `convex.config.ts` / `auth.ts` import from. */
const AUTH_PACKAGE = "@convex-dev/auth";

/** Where to grab the v2 (reboot) build from until it's on npm proper. */
const INSTALL_SPEC = `${AUTH_PACKAGE}@https://pkg.pr.new/${AUTH_PACKAGE}@reboot`;

/** Files scaffolded into the project's `convex/` directory, in write order. */
export const FILE_TEMPLATES = {
  "auth.config.ts": `import { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "convex",
      issuer: process.env.CONVEX_SITE_URL!,
      jwks: \`\${process.env.CONVEX_SITE_URL}/auth/.well-known/jwks.json\`,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
`,
  "convex.config.ts": `import { defineApp } from "convex/server";
import { v } from "convex/values";
import core from "@convex-dev/auth/core/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});

app.use(core, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
// TODO Add auth providers

export default app;
`,
  "auth.ts": `import { components, internal } from "./_generated/api";
import { provider, setupCore } from "@convex-dev/auth/core/setup.js";

export const {
  signOut,
  refreshSession,
  providers: {
    // TODO
  },
} = setupCore({
  component: components.core,
  providers: [
    // TODO
  ],
}).attachUserCallback(internal.users.createOrUpdateUser);
`,
};

/** The install command for a given package manager. */
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type AuthKeys = {
  authPrivateKey: string;
  authJwks: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type InitDeps = {
  cwd: () => string;
  fs: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string) => string;
    writeFileSync: (path: string, contents: string) => void;
    mkdirSync: (path: string, options: { recursive: true }) => unknown;
  };
  log: (message: string) => void;
  warn: (message: string) => void;
  generateKeys: () => Promise<AuthKeys>;
  getEnv: (key: string) => string | null;
  setEnv: (key: string, value: string) => void;
  detectPackageManager: (dir: string) => string;
};

export function installCommand(packageManager: string) {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${INSTALL_SPEC}`;
    case "bun":
      return `bun add ${INSTALL_SPEC}`;
    case "yarn":
      return `yarn add ${INSTALL_SPEC}`;
    case "npm":
    default:
      return `npm install ${INSTALL_SPEC}`;
  }
}

/**
 * Detect the package manager in use, preferring the agent that actually invoked
 * the CLI (`npm_config_user_agent`) and falling back to whichever lockfile is
 * present in `dir`. Defaults to npm.
 */
export function detectPackageManager(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const userAgent = env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("bun")) return "bun";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("npm")) return "npm";

  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
    return "bun";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Generate a fresh RS256 key pair as base64 PKCS8 + a JWKS JSON string. */
async function generateAuthKeys() {
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  const privatePem = await exportPKCS8(privateKey);
  const pubJwk = await exportJWK(publicKey);
  const kid = randomUUID();

  return {
    authPrivateKey: Buffer.from(privatePem).toString("base64"),
    authJwks: JSON.stringify({
      keys: [{ ...pubJwk, kid, alg: ALG, use: "sig" }],
    }),
  };
}

/** Read an env var off the current directory's Convex deployment. */
function getConvexEnv(key: string) {
  const result = spawnSync("npx", ["convex", "env", "get", key], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

/** Set an env var on the current directory's Convex deployment. */
function setConvexEnv(key: string, value: string) {
  const result = spawnSync("npx", ["convex", "env", "set", key, value], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error(`Failed to set ${key} on the Convex deployment.`);
  }
}

/** The real implementations, injected into `runInit` (overridden in tests). */
export function defaultDeps(): InitDeps {
  return {
    cwd: () => process.cwd(),
    fs: {
      existsSync,
      readFileSync: (path) => readFileSync(path, "utf8"),
      writeFileSync,
      mkdirSync,
    },
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    generateKeys: generateAuthKeys,
    getEnv: getConvexEnv,
    setEnv: setConvexEnv,
    detectPackageManager,
  };
}

/** Whether `@convex-dev/auth` appears in the package's (dev)dependencies. */
function hasAuthDependency(pkg: PackageJson) {
  return (
    AUTH_PACKAGE in (pkg.dependencies ?? {}) ||
    AUTH_PACKAGE in (pkg.devDependencies ?? {})
  );
}

/** Indent a block of text for display inside a warning. */
function indent(text: string) {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join("\n");
}

/** Ensure the signing keys exist on the deployment (idempotent). */
async function ensureAuthKeys(deps: InitDeps, force: boolean) {
  if (!force && deps.getEnv("AUTH_PRIVATE_KEY") && deps.getEnv("AUTH_JWKS")) {
    deps.log(
      "AUTH_PRIVATE_KEY and AUTH_JWKS are already set; leaving them unchanged " +
        "(pass --force to rotate the signing key).",
    );
    return;
  }
  const { authPrivateKey, authJwks } = await deps.generateKeys();
  deps.setEnv("AUTH_PRIVATE_KEY", authPrivateKey);
  deps.setEnv("AUTH_JWKS", authJwks);
  deps.log("Set AUTH_PRIVATE_KEY and AUTH_JWKS on the Convex deployment.");
}

/**
 * Write each scaffolded file into `convex/`, creating the directory if needed.
 * A file that already exists is never overwritten: instead we warn and print
 * the content it should contain.
 */
function writeAuthFiles(deps: InitDeps, dir: string) {
  const convexDir = join(dir, "convex");
  if (!deps.fs.existsSync(convexDir)) {
    deps.fs.mkdirSync(convexDir, { recursive: true });
  }

  for (const [name, content] of Object.entries(FILE_TEMPLATES)) {
    const filePath = join(convexDir, name);
    if (deps.fs.existsSync(filePath)) {
      deps.warn(
        `\n⚠ convex/${name} already exists — leaving it untouched.\n` +
          `  Make sure it contains the following:\n\n${indent(content)}`,
      );
      continue;
    }
    deps.fs.writeFileSync(filePath, content);
    deps.log(`  created convex/${name}`);
  }
}

/**
 * Run the full initialization against the injected `deps`. Fatal problems are
 * reported via `command.error`, which prints to stderr and exits (or throws a
 * `CommanderError` when the command has `exitOverride` set, as in tests).
 */
async function runInit(
  deps: InitDeps,
  options: { force?: boolean },
  command: Command,
) {
  const dir = deps.cwd();
  const pkgPath = join(dir, "package.json");

  if (!deps.fs.existsSync(pkgPath)) {
    command.error(
      `No package.json found in ${dir}.\n` +
        "Run this command from the root of your project.",
    );
    return;
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(deps.fs.readFileSync(pkgPath));
  } catch {
    command.error(`Could not parse ${pkgPath} as JSON.`);
    return;
  }

  if (!hasAuthDependency(pkg)) {
    const packageManager = deps.detectPackageManager(dir);
    command.error(
      `${AUTH_PACKAGE} is not a dependency of this project.\n\n` +
        "Install it first, then re-run this command:\n\n" +
        `  ${installCommand(packageManager)}\n`,
    );
    return;
  }

  deps.log("Setting up the auth signing keys…");
  await ensureAuthKeys(deps, options.force ?? false);

  deps.log("Scaffolding Convex Auth files…");
  writeAuthFiles(deps, dir);

  deps.log(
    "\nConvex Auth is set up. Next: add a provider to convex/auth.ts and " +
      "convex/convex.config.ts (see the TODOs), then run your dev server.",
  );
}

/** Build the commander program, wired to the given dependencies. */
export function createProgram(deps: InitDeps = defaultDeps()) {
  const program = new Command();
  program
    .name("@convex-dev/auth")
    .description("Initialize a basic Convex Auth project")
    .option("--force", "Regenerate the auth signing keys even if already set")
    .action((options, command) => runInit(deps, options, command));
  return program;
}

export { runInit };
