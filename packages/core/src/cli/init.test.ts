// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  createProgram,
  declaresNodeTypes,
  detectPackageManager,
  devInstallCommand,
  FILE_TEMPLATES,
  installCommand,
} from "./program.js";

const PROJECT = "/project";

/** Minimal in-memory stand-in for the subset of `node:fs` the CLI uses. */
function makeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      const contents = files.get(p);
      if (contents === undefined) throw new Error(`ENOENT: ${p}`);
      return contents;
    },
    writeFileSync: (p: string, contents: string) => {
      files.set(p, contents);
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
  };
}

type Overrides = {
  files?: Record<string, string>;
  getEnv?: (key: string) => string | null;
  generateKeys?: () => Promise<{ authPrivateKey: string; authJwks: string }>;
  detectPackageManager?: (dir: string) => string;
};

function makeDeps(overrides: Overrides = {}) {
  const fs = makeFs(overrides.files);
  const logs: string[] = [];
  const warns: string[] = [];
  const setEnvCalls: Array<[string, string]> = [];
  const generateKeys = vi.fn(
    overrides.generateKeys ??
      (async () => ({ authPrivateKey: "PRIV", authJwks: "JWKS" })),
  );
  const deps = {
    cwd: () => PROJECT,
    fs,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
    getEnv: overrides.getEnv ?? (() => null),
    setEnv: (k: string, v: string) => setEnvCalls.push([k, v]),
    generateKeys,
    detectPackageManager: overrides.detectPackageManager ?? (() => "npm"),
  };
  return { deps, fs, logs, warns, setEnvCalls, generateKeys };
}

/** Drive the CLI exactly as a user would, but capture output/exit. */
async function runCli(deps: unknown, args: string[] = []) {
  const stderr: string[] = [];
  // The stub deps intentionally implement only the narrow surface the CLI uses,
  // so widen to the parameter type the loosely-typed .mjs expects.
  const program = createProgram(deps as Parameters<typeof createProgram>[0]);
  program.exitOverride();
  program.configureOutput({
    writeErr: (s) => stderr.push(s),
    writeOut: () => {},
  });
  let error: Error | undefined;
  try {
    await program.parseAsync(["node", "convex-auth", ...args]);
  } catch (e) {
    error = e as Error;
  }
  return { error, stderr: stderr.join("") };
}

const pkgWithAuth = JSON.stringify({
  dependencies: { "@convex-dev/auth": "^2.0.0" },
  devDependencies: { "@types/node": "^24.0.0" },
});

/** A `convex/tsconfig.json` that already lists Node's global types. */
const tsconfigWithNodeTypes = JSON.stringify({
  compilerOptions: { types: ["node"] },
});

describe("convex-auth init CLI", () => {
  test("crashes with the install command when @convex-dev/auth is missing", async () => {
    const { deps, fs, setEnvCalls } = makeDeps({
      files: { "/project/package.json": JSON.stringify({ dependencies: {} }) },
      detectPackageManager: () => "pnpm",
    });

    const { error } = await runCli(deps);

    expect(error).toBeDefined();
    expect(error!.message).toContain("is not a dependency");
    expect(error!.message).toContain(
      "pnpm add @convex-dev/auth@https://pkg.pr.new/@convex-dev/auth@reboot",
    );
    // It must not touch env vars or write any files on this path.
    expect(setEnvCalls).toEqual([]);
    expect(fs.files.has("/project/convex/auth.ts")).toBe(false);
  });

  test("crashes when there is no package.json", async () => {
    const { deps } = makeDeps({ files: {} });
    const { error } = await runCli(deps);
    expect(error).toBeDefined();
    expect(error!.message).toContain("No package.json found");
  });

  test("crashes when package.json is not valid JSON", async () => {
    const { deps } = makeDeps({
      files: { "/project/package.json": "{ not json" },
    });
    const { error } = await runCli(deps);
    expect(error).toBeDefined();
    expect(error!.message).toContain("Could not parse");
  });

  test("sets env vars and scaffolds all files on the happy path", async () => {
    const { deps, fs, logs, setEnvCalls, generateKeys } = makeDeps({
      files: { "/project/package.json": pkgWithAuth },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    expect(generateKeys).toHaveBeenCalledTimes(1);
    expect(setEnvCalls).toEqual([
      ["AUTH_PRIVATE_KEY", "PRIV"],
      ["AUTH_JWKS", "JWKS"],
    ]);

    // The convex/ directory is created and every template is written verbatim.
    expect(fs.dirs.has("/project/convex")).toBe(true);
    for (const [name, content] of Object.entries(FILE_TEMPLATES)) {
      expect(fs.files.get(`/project/convex/${name}`)).toBe(content);
      expect(logs.join("\n")).toContain(`created convex/${name}`);
    }
  });

  test("recognizes @convex-dev/auth listed under devDependencies", async () => {
    const { deps, fs } = makeDeps({
      files: {
        "/project/package.json": JSON.stringify({
          devDependencies: { "@convex-dev/auth": "^2.0.0" },
        }),
      },
    });
    const { error } = await runCli(deps);
    expect(error).toBeUndefined();
    expect(fs.files.has("/project/convex/auth.ts")).toBe(true);
  });

  test("leaves the keys untouched when both are already set", async () => {
    const { deps, logs, setEnvCalls, generateKeys } = makeDeps({
      files: { "/project/package.json": pkgWithAuth },
      getEnv: () => "already-set",
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    expect(generateKeys).not.toHaveBeenCalled();
    expect(setEnvCalls).toEqual([]);
    expect(logs.join("\n")).toContain("already set");
  });

  test("--force rotates the keys even when both are already set", async () => {
    const { deps, setEnvCalls, generateKeys } = makeDeps({
      files: { "/project/package.json": pkgWithAuth },
      getEnv: () => "already-set",
    });

    const { error } = await runCli(deps, ["--force"]);

    expect(error).toBeUndefined();
    expect(generateKeys).toHaveBeenCalledTimes(1);
    expect(setEnvCalls).toEqual([
      ["AUTH_PRIVATE_KEY", "PRIV"],
      ["AUTH_JWKS", "JWKS"],
    ]);
  });

  test("does not overwrite an existing file, but warns with its content", async () => {
    const { deps, fs, warns } = makeDeps({
      files: {
        "/project/package.json": pkgWithAuth,
        "/project/convex/auth.ts": "// my hand-written auth.ts",
      },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    // Untouched…
    expect(fs.files.get("/project/convex/auth.ts")).toBe(
      "// my hand-written auth.ts",
    );
    // …but the warning tells the user what it should contain.
    const warning = warns.join("\n");
    expect(warning).toContain("convex/auth.ts already exists");
    expect(warning).toContain("setupCore");
    // The other files were still created.
    expect(fs.files.get("/project/convex/convex.config.ts")).toBe(
      FILE_TEMPLATES["convex.config.ts"],
    );
  });
});

describe("typecheck setup warning", () => {
  test("names both steps when neither is in place", async () => {
    const { deps, warns } = makeDeps({
      files: {
        "/project/package.json": JSON.stringify({
          dependencies: { "@convex-dev/auth": "^2.0.0" },
        }),
      },
      detectPackageManager: () => "pnpm",
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    const warning = warns.join("\n");
    expect(warning).toContain("TS2591");
    expect(warning).toContain("pnpm add -D @types/node");
    expect(warning).toContain('"types": ["node"] to convex/tsconfig.json');
  });

  test("only names the tsconfig step when @types/node is installed", async () => {
    const { deps, warns } = makeDeps({
      files: { "/project/package.json": pkgWithAuth },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    const warning = warns.join("\n");
    expect(warning).toContain('"types": ["node"] to convex/tsconfig.json');
    expect(warning).not.toContain("@types/node\n");
  });

  test("stays quiet once both are in place", async () => {
    const { deps, warns } = makeDeps({
      files: {
        "/project/package.json": pkgWithAuth,
        "/project/convex/tsconfig.json": tsconfigWithNodeTypes,
      },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    expect(warns.join("\n")).not.toContain("TS2591");
  });
});

describe("declaresNodeTypes", () => {
  test.each([
    ['{ "compilerOptions": { "types": ["node"] } }', true],
    ['{ "compilerOptions": { "types": ["node", "vite/client"] } }', true],
    ['{ "compilerOptions": { "types" : [ "vite/client", "node" ] } }', true],
    ['{ "compilerOptions": { "types": ["vite/client"] } }', false],
    ['{ "compilerOptions": { "noEmit": true } }', false],
  ])("%s", (contents, expected) => {
    expect(declaresNodeTypes(contents)).toBe(expected);
  });
});

describe("devInstallCommand", () => {
  test.each([
    ["npm", "npm install --save-dev @types/node"],
    ["pnpm", "pnpm add -D @types/node"],
    ["yarn", "yarn add -D @types/node"],
    ["bun", "bun add -d @types/node"],
  ])("%s", (pm, expected) => {
    expect(devInstallCommand(pm, "@types/node")).toBe(expected);
  });

  test("falls back to npm for an unknown package manager", () => {
    expect(devInstallCommand("who-knows", "@types/node")).toContain(
      "npm install --save-dev",
    );
  });
});

describe("installCommand", () => {
  test.each([
    ["npm", "npm install"],
    ["pnpm", "pnpm add"],
    ["bun", "bun add"],
    ["yarn", "yarn add"],
  ])("%s uses the right add command", (pm, prefix) => {
    expect(installCommand(pm)).toContain(prefix);
    expect(installCommand(pm)).toContain(
      "@convex-dev/auth@https://pkg.pr.new/@convex-dev/auth@reboot",
    );
  });

  test("unknown package managers fall back to npm", () => {
    expect(installCommand("who-knows")).toContain("npm install");
  });
});

describe("detectPackageManager", () => {
  test("prefers the invoking agent from npm_config_user_agent", () => {
    expect(
      detectPackageManager("/nowhere", {
        npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20",
      }),
    ).toBe("pnpm");
    expect(
      detectPackageManager("/nowhere", {
        npm_config_user_agent: "bun/1.1.0",
      }),
    ).toBe("bun");
  });

  test("falls back to npm with no signal", () => {
    expect(detectPackageManager("/nowhere", {})).toBe("npm");
  });
});
