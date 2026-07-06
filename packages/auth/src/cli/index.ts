import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import * as p from "@clack/prompts";
import { config as loadEnvFile } from "dotenv";
import figlet from "figlet";
import ansiShadow from "figlet/importable-fonts/ANSI Shadow.js";
import gradientString from "gradient-string";

import { generateKeys } from "./keys";

figlet.parseFont("ANSI Shadow", ansiShadow);

const convexGradient = gradientString(["purple", "pink", "orange"]);

function printBanner() {
  const banner = figlet.textSync("CONVEX-AUTH", {
    font: "ANSI Shadow",
    horizontalLayout: "default",
  });
  console.log("\n" + convexGradient(banner));
  console.log("  \x1b[35m✦ auth, wired into your convex backend  ✦\x1b[0m\n");
}

function getPackageVersion(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (const relative of ["..", "../.."]) {
    try {
      const pkgPath = path.resolve(currentDir, relative, "package.json");
      return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
    } catch {
      /* empty */
    }
  }
  return "unknown";
}

const version = getPackageVersion();

type PackageRunner = { cmd: string; args: string[] };

function detectPackageRunner(): PackageRunner {
  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (typeof pkg.packageManager === "string") {
          const name = pkg.packageManager.split("@")[0];
          if (name === "pnpm") return { cmd: "pnpm", args: ["exec"] };
          if (name === "bun") return { cmd: "bunx", args: [] };
          if (name === "yarn") return { cmd: "yarn", args: ["dlx"] };
        }
      } catch {
        /* empty */
      }
    }

    if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return { cmd: "pnpm", args: ["exec"] };
    if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock")))
      return { cmd: "bunx", args: [] };
    if (existsSync(path.join(dir, "yarn.lock"))) return { cmd: "yarn", args: ["dlx"] };

    dir = path.dirname(dir);
  }

  return { cmd: "npx", args: [] };
}

const runner = detectPackageRunner();

function convexCmd(...subArgs: string[]): { file: string; args: string[] } {
  return { file: runner.cmd, args: [...runner.args, "convex", ...subArgs] };
}

type CliOptions = {
  command: "setup" | "doctor" | "urls" | "keys";
  appUrl?: string;
  variables?: string;
  skipGitCheck: boolean;
  allowDirtyGitState: boolean;
  url?: string;
  adminKey?: string;
  prod: boolean;
  previewName?: string;
  deploymentName?: string;
};

const flagDefs = new Map<string, { type: "string" | "boolean"; description: string }>([
  [
    "app-url",
    {
      type: "string",
      description:
        "Your frontend app URL (e.g. 'http://localhost:5173' for dev, 'https://myapp.com' for prod)",
    },
  ],
  [
    "variables",
    {
      type: "string",
      description: "Configure additional variables for interactive configuration.",
    },
  ],
  [
    "skip-git-check",
    {
      type: "boolean",
      description: "Don't warn when running outside a Git checkout.",
    },
  ],
  [
    "allow-dirty-git-state",
    {
      type: "boolean",
      description: "Don't warn when Git state is not clean.",
    },
  ],
  ["url", { type: "string", description: "Convex deployment URL." }],
  ["admin-key", { type: "string", description: "Convex admin key." }],
  [
    "prod",
    {
      type: "boolean",
      description: "Set environment variables on this project's production deployment.",
    },
  ],
  [
    "preview-name",
    {
      type: "string",
      description: "Set environment variables on the preview deployment with the given name.",
    },
  ],
  [
    "deployment-name",
    {
      type: "string",
      description: "Set environment variables on the specified deployment.",
    },
  ],
  ["help", { type: "boolean", description: "Show this help message." }],
  ["version", { type: "boolean", description: "Show version." }],
]);

function printHelp() {
  printBanner();
  console.log("  Add code and set environment variables for @robelest/convex-auth.\n");
  console.log("  Full docs: https://auth.estifanos.com\n");
  console.log("  Commands:\n");
  console.log("    setup                         Scaffold files and set env vars");
  console.log("    doctor                        Verify env, files, and mounted auth endpoints");
  console.log("    urls                          Print auth endpoint and provider callback URLs");
  console.log("    keys                          Generate signing/encryption keys\n");
  console.log("  Options:\n");
  for (const [name, def] of flagDefs) {
    const flag = def.type === "boolean" ? `--${name}` : `--${name} <value>`;
    console.log(`    ${flag.padEnd(32)} ${def.description}`);
  }
  console.log();
}

function parseArgs(argv: string[]): CliOptions {
  const rawArgs = argv.slice(2);
  const knownCommands = new Set(["setup", "doctor", "urls", "keys"]);
  const firstArg = rawArgs[0];
  const command = knownCommands.has(firstArg ?? "") ? (firstArg as CliOptions["command"]) : "setup";
  const args =
    command === "setup" && !knownCommands.has(firstArg ?? "") ? rawArgs : rawArgs.slice(1);

  const strings = new Map<string, string>();
  const booleans = new Set<string>();

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      i++;
      continue;
    }
    const name = arg.slice(2);
    const def = flagDefs.get(name);
    if (def === undefined) {
      p.log.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
    if (def.type === "boolean") {
      booleans.add(name);
      i++;
    } else {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        p.log.error(`Flag --${name} requires a value.`);
        process.exit(1);
      }
      strings.set(name, value);
      i += 2;
    }
  }

  if (booleans.has("help")) {
    printHelp();
    process.exit(0);
  }
  if (booleans.has("version")) {
    console.log(version);
    process.exit(0);
  }

  return {
    command,
    appUrl: strings.get("app-url"),
    variables: strings.get("variables"),
    skipGitCheck: booleans.has("skip-git-check"),
    allowDirtyGitState: booleans.has("allow-dirty-git-state"),
    url: strings.get("url"),
    adminKey: strings.get("admin-key"),
    prod: booleans.has("prod"),
    previewName: strings.get("preview-name"),
    deploymentName: strings.get("deployment-name"),
  };
}

function validateDeploymentSelectionOptions(options: CliOptions) {
  const selectionCount = [
    options.url !== undefined,
    options.prod,
    options.previewName !== undefined,
    options.deploymentName !== undefined,
  ].filter(Boolean).length;
  if (selectionCount > 1) {
    logErrorAndExit("Choose only one of --url, --prod, --preview-name, or --deployment-name.");
  }
}

function handleCancel(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(1);
  }
}

async function runSetup(options: CliOptions) {
  validateDeploymentSelectionOptions(options);

  printBanner();
  p.intro("Starting configuration wizard...");

  await checkSourceControl(options);

  const packageJson = readPackageJson();
  const convexJson = readConvexJson();
  const deployment = readConvexDeployment(options);
  const convexFolderPath = convexJson.functions ?? "convex";

  const isNextjs = !!packageJson.dependencies?.next;
  const usesTypeScript = !!(
    packageJson.dependencies?.typescript || packageJson.devDependencies?.typescript
  );
  const isVite = !!(packageJson.dependencies?.vite || packageJson.devDependencies?.vite);
  const isExpo = !!(packageJson.dependencies?.expo || packageJson.devDependencies?.expo);
  const config: ProjectConfig = {
    isNextjs,
    isVite,
    isExpo,
    usesTypeScript,
    convexFolderPath,
    deployment,
    step: 1,
  };

  await configureAppUrl(config, options.appUrl);
  await configureKeys(config);
  await modifyTsConfig(config);
  await configureConvexConfig(config);
  await initializeAuth(config);
  await initializeHttp(config);
  await initializeAuthCore(config);
  await initializeAuthConfig(config);

  if (options.variables !== undefined) {
    await configureOtherVariables(config, options.variables);
  } else {
    printFinalSuccessMessage(config);
  }

  p.outro("Done! Happy building.");
}

async function runDoctor(options: CliOptions) {
  validateDeploymentSelectionOptions(options);
  printBanner();
  p.intro("Checking Convex Auth setup...");
  const convexJson = readConvexJson();
  const convexFolderPath = convexJson.functions ?? "convex";
  const configPath = existingNonEmptySourcePath(path.join(convexFolderPath, "convex.config"));
  const authPath = existingNonEmptySourcePath(path.join(convexFolderPath, "auth"));
  const authConfigPath = existingNonEmptySourcePath(path.join(convexFolderPath, "auth.config"));

  if (configPath === null) p.log.warn("Missing convex.config.ts/js.");
  else p.log.success(`Found ${configPath}`);
  if (authPath === null) p.log.warn("Missing auth.ts/js.");
  else p.log.success(`Found ${authPath}`);
  if (authConfigPath === null) p.log.warn("Missing auth.config.ts/js.");
  else p.log.success(`Found ${authConfigPath}`);

  p.outro("Doctor checks complete.");
}

async function runUrls(options: CliOptions) {
  validateDeploymentSelectionOptions(options);
  printBanner();
  const deployment = readConvexDeployment(options);
  const convexSiteUrl = deployment.options.url ?? "https://<deployment>.convex.site";
  const authSiteUrl = `${convexSiteUrl.replace(/\/$/, "")}/auth`;
  p.log.info("Convex Auth URLs:");
  p.log.message(
    [
      `Issuer: ${authSiteUrl}`,
      `OpenID configuration: ${authSiteUrl}/.well-known/openid-configuration`,
      `JWKS: ${authSiteUrl}/.well-known/jwks.json`,
      `OAuth sign-in base: ${authSiteUrl}/signin/<provider>`,
      `OAuth callback base: ${authSiteUrl}/callback/<provider>`,
      `Connection connections base: ${authSiteUrl}/connections/<connectionId>`,
    ].join("\n"),
  );
}

async function runKeys(options: CliOptions) {
  validateDeploymentSelectionOptions(options);
  printBanner();
  const convexJson = readConvexJson();
  const deployment = readConvexDeployment(options);
  await configureKeys({
    isExpo: false,
    isNextjs: false,
    isVite: false,
    usesTypeScript: true,
    convexFolderPath: convexJson.functions ?? "convex",
    deployment,
    step: 1,
  });
}

/**
 * Run the interactive Convex Auth setup wizard.
 *
 * Parses CLI flags, detects the target Convex deployment, configures required
 * environment variables, and scaffolds the expected auth files in the current
 * project.
 *
 * @param argv - Process arguments. Defaults to `process.argv`.
 * @returns A promise that resolves when setup completes successfully.
 */
const runCli = async (argv = process.argv) => {
  const options = parseArgs(argv);
  if (options.command === "setup") await runSetup(options);
  else if (options.command === "doctor") await runDoctor(options);
  else if (options.command === "urls") await runUrls(options);
  else if (options.command === "keys") await runKeys(options);
};

/**
 * Run the Convex Auth CLI and exit the process on failure.
 *
 * @param argv - Process arguments. Defaults to `process.argv`.
 */
export function runCliMain(argv = process.argv) {
  runCli(argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

type ProjectConfig = {
  isExpo: boolean;
  isNextjs: boolean;
  isVite: boolean;
  usesTypeScript: boolean;
  convexFolderPath: string;
  deployment: {
    name: string | null;
    type: string | null;
    options: {
      url?: string;
      adminKey?: string;
      prod?: boolean;
      previewName?: string;
      deploymentName?: string;
    };
  };
  step: number;
};

async function configureAppUrl(config: ProjectConfig, forcedValue?: string) {
  logStep(config, "Configure APP_URL");
  const value =
    config.deployment.type === "dev" || config.deployment.type === null
      ? config.isVite
        ? "http://localhost:5173"
        : "http://localhost:3000"
      : undefined;
  const description =
    config.deployment.type === "dev"
      ? "the URL of your local web server (e.g. http://localhost:1234)"
      : "the URL where your site is hosted (e.g. https://example.com)";

  await configureEnvVar(config, {
    name: "APP_URL",
    default: value,
    description,
    validate: (input: string | undefined) => {
      if (!input || input.trim() === "") {
        return "URL is required";
      }
      try {
        new URL(input);
        return undefined;
      } catch {
        return "The URL must start with http:// or https://";
      }
    },
    forcedValue,
  });
}

async function configureEnvVar(
  config: ProjectConfig,
  variable: {
    name: string;
    default?: string;
    description: string;
    validate?: (input: string | undefined) => string | undefined;
    forcedValue?: string;
  },
) {
  if (variable.forcedValue) {
    if (variable.validate) {
      const err = variable.validate(variable.forcedValue);
      if (err) {
        logErrorAndExit(`Invalid value for ${variable.name}: ${err}`);
      }
    }
    if (variable.forcedValue.trim() === "") {
      return;
    }
    await setEnvVar(config, variable.name, variable.forcedValue);
    return;
  }

  const existing = backendEnvVar(config, variable.name);
  if (existing !== "") {
    const shouldChange = await p.confirm({
      message: `${variable.name} is already set to "${existing}" on ${printDeployment(config)}. Change it?`,
      initialValue: false,
    });
    handleCancel(shouldChange);
    if (!shouldChange) {
      return;
    }
  }

  const rawValue = await p.text({
    message: `Enter ${variable.description}`,
    placeholder: variable.default,
    defaultValue: variable.default,
    validate: variable.validate,
  });
  handleCancel(rawValue);
  const chosenValue = rawValue as string;

  if (chosenValue.trim() === "") {
    return;
  }
  await setEnvVar(config, variable.name, chosenValue);
}

async function configureKeys(config: ProjectConfig) {
  logStep(config, "Configure signing and encryption keys");
  const s = p.spinner();
  s.start("Generating keys...");
  const { JWT_PRIVATE_KEY, JWKS, AUTH_SECRET_ENCRYPTION_KEY } = await generateKeys();
  s.stop("Keys generated.");

  const existingPrivateKey = backendEnvVar(config, "JWT_PRIVATE_KEY");
  const existingJwks = backendEnvVar(config, "JWKS");
  const existingSecretEncryptionKey = backendEnvVar(config, "AUTH_SECRET_ENCRYPTION_KEY");
  if (existingPrivateKey !== "" || existingJwks !== "" || existingSecretEncryptionKey !== "") {
    const shouldOverwrite = await p.confirm({
      message: `${printDeployment(config)} already has auth keys configured. Overwrite them?`,
      initialValue: false,
    });
    handleCancel(shouldOverwrite);
    if (!shouldOverwrite) {
      return;
    }
  }

  const s2 = p.spinner();
  s2.start("Setting keys on deployment...");
  await setEnvVarFromFile(config, "JWT_PRIVATE_KEY", JWT_PRIVATE_KEY);
  await setEnvVarFromFile(config, "JWKS", JWKS);
  await setEnvVar(config, "AUTH_SECRET_ENCRYPTION_KEY", AUTH_SECRET_ENCRYPTION_KEY, {
    hideValue: true,
  });
  s2.stop("Keys configured.");
}

function backendEnvVar(config: ProjectConfig, name: string): string {
  const { file, args } = convexCmd("env", "get", ...deploymentArgs(config), name);
  return execFileSync(file, args, {
    stdio: "pipe",
    encoding: "utf-8",
  }).slice(0, -1);
}

async function setEnvVar(
  config: ProjectConfig,
  name: string,
  value: string,
  options?: { hideValue: boolean },
) {
  const { file, args } = convexCmd("env", "set", ...deploymentArgs(config), "--", name, value);
  execFileSync(file, args, {
    stdio: options?.hideValue ? "ignore" : "inherit",
  });
  if (options?.hideValue) {
    p.log.success(`Set ${name} on ${printDeployment(config)}`);
  }
}

async function setEnvVarFromFile(config: ProjectConfig, name: string, value: string) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "convex-auth-"));
  const tmpFile = path.join(tmpDir, `${name}.tmp`);
  try {
    writeFileSync(tmpFile, value, "utf-8");
    const { file, args } = convexCmd(
      "env",
      "set",
      ...deploymentArgs(config),
      name,
      "--from-file",
      tmpFile,
    );
    execFileSync(file, args, { stdio: "ignore" });
    p.log.success(`Set ${name} on ${printDeployment(config)}`);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* empty */
    }
  }
}

function deploymentArgs(config: ProjectConfig): string[] {
  const {
    deployment: {
      options: { adminKey, url, prod, previewName, deploymentName },
    },
  } = config;
  const args: string[] = [];

  if (adminKey !== undefined) {
    args.push("--admin-key", adminKey);
  }

  const selectionArgs =
    [
      url ? ["--url", url] : null,
      prod ? ["--prod"] : null,
      previewName ? ["--preview-name", previewName] : null,
      deploymentName ? ["--deployment-name", deploymentName] : null,
    ].find((s): s is string[] => s !== null) ?? [];

  args.push(...selectionArgs);
  return args;
}

function printDeployment(config: ProjectConfig): string {
  const { name, type } = config.deployment;
  return (type !== null ? `${type} ` : "") + "deployment" + (name !== null ? ` ${name}` : "");
}

const compilerOptionsPattern =
  /("compilerOptions"\s*:\s*\{(?:\s*(?:\/\*(?:[^*]|\*(?!\/))*\*\/))*(\s*))(?=")/;

const validTsConfig = `\
{
  /* This TypeScript project config describes the environment that
   * Convex functions run in and is used to typecheck them.
   * You can modify it, but some settings required to use Convex.
   */
  "compilerOptions": {
    /* These settings are not required by Convex and can be modified. */
    "allowJs": true,
    "strict": true,
    "skipLibCheck": true,
    "jsx": "react",

    /* These compiler options are required by Convex */
    "target": "ESNext",
    "lib": ["ES2021", "dom", "ES2023.Array"],
    "forceConsistentCasingInFileNames": true,
    "allowSyntheticDefaultImports": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["./**/*"],
  "exclude": ["./_generated"]
}
`;

async function modifyTsConfig(config: ProjectConfig) {
  logStep(config, "Modify tsconfig file");
  const projectLevelTsConfigPath = "tsconfig.json";
  const tsConfigPath = path.join(config.convexFolderPath, "tsconfig.json");
  if (!existsSync(tsConfigPath)) {
    if (existsSync(projectLevelTsConfigPath)) {
      if (config.isExpo) {
        writeFileSync(tsConfigPath, validTsConfig);
        p.log.success(`Added ${tsConfigPath}`);
        return;
      }
    }
    p.log.info(`No ${tsConfigPath} found. Skipping.`);
    return;
  }
  const existingTsConfig = readFileSync(tsConfigPath, "utf8");
  const moduleResolutionPattern = /"moduleResolution"\s*:\s*"(\w+)"/;
  const [, existingModuleResolution] = existingTsConfig.match(moduleResolutionPattern) ?? [];
  const skipLibCheckPattern = /"skipLibCheck"\s*:\s*(\w+)/;
  const [, existingSkipLibCheck] = existingTsConfig.match(skipLibCheckPattern) ?? [];
  if (/Bundler/i.test(existingModuleResolution) && existingSkipLibCheck === "true") {
    p.log.success(`${tsConfigPath} is already set up.`);
    return;
  }

  if (!compilerOptionsPattern.test(existingTsConfig)) {
    p.log.info(`Modify your ${tsConfigPath} to include the following:`);
    p.log.message(indent(`\n"moduleResolution": "Bundler",\n"skipLibCheck": true\n`));
    const ready = await p.confirm({ message: "Ready to continue?" });
    handleCancel(ready);
    if (!ready) {
      p.cancel("Setup cancelled.");
      process.exit(1);
    }
  }
  const changedTsConfig = addCompilerOption(
    addCompilerOption(
      existingTsConfig,
      existingModuleResolution,
      moduleResolutionPattern,
      '"moduleResolution": "Bundler"',
    ),
    existingSkipLibCheck,
    skipLibCheckPattern,
    '"skipLibCheck": true',
  );
  writeFileSync(tsConfigPath, changedTsConfig);
  p.log.success(`Modified ${tsConfigPath}`);
}

function addCompilerOption(
  tsconfig: string,
  existingValue: string | undefined,
  pattern: RegExp,
  optionAndValue: string,
) {
  if (existingValue === undefined) {
    return tsconfig.replace(compilerOptionsPattern, `$1${optionAndValue},$2`);
  } else {
    return tsconfig.replace(pattern, optionAndValue);
  }
}

async function configureConvexConfig(config: ProjectConfig) {
  logStep(config, "Configure convex config file");
  const sourceTemplate = `\
import { defineApp } from "convex/server";
import auth from "@robelest/convex-auth/convex.config";

const app = defineApp();

app.use(auth);

export default app;
`;
  const source = templateToSource(sourceTemplate);
  const convexConfigPath = path.join(config.convexFolderPath, "convex.config");
  const existingConfigPath = existingNonEmptySourcePath(convexConfigPath);
  if (existingConfigPath !== null) {
    const existingConfig = readFileSync(existingConfigPath, "utf8");
    if (doesAlreadyMatchTemplate(existingConfig, sourceTemplate)) {
      p.log.success(`${existingConfigPath} is already set up.`);
    } else {
      p.log.info(
        `You already have ${existingConfigPath}. Make sure it registers the auth component:`,
      );
      p.log.message(indent(`\n${source}\n`));
      const ready = await p.confirm({ message: "Ready to continue?" });
      handleCancel(ready);
      if (!ready) {
        p.cancel("Setup cancelled.");
        process.exit(1);
      }
    }
  } else {
    const newConfigPath = config.usesTypeScript
      ? `${convexConfigPath}.ts`
      : `${convexConfigPath}.js`;
    writeFileSync(newConfigPath, source);
    p.log.success(`Created ${newConfigPath}`);
  }
}

async function initializeAuth(config: ProjectConfig) {
  logStep(config, "Initialize auth file");
  const sourceTemplate = `\
import { defineAuth } from "@robelest/convex-auth/component";
import { components } from "./_generated/api";

const auth = defineAuth(components.auth, {$$
  providers: [$$],$$
});

export { auth };
export const { signIn, signOut, store } = auth;
`;
  const source = templateToSource(sourceTemplate);
  const authPath = path.join(config.convexFolderPath, "auth");
  const existingAuthPath = existingNonEmptySourcePath(authPath);
  if (existingAuthPath !== null) {
    const existingAuth = readFileSync(existingAuthPath, "utf8");
    if (doesAlreadyMatchTemplate(existingAuth, sourceTemplate)) {
      p.log.success(`${existingAuthPath} is already set up.`);
    } else {
      p.log.info(
        `You already have ${existingAuthPath}. Make sure it initializes auth with defineAuth:`,
      );
      p.log.message(indent(`\n${source}\n`));
      const ready = await p.confirm({ message: "Ready to continue?" });
      handleCancel(ready);
      if (!ready) {
        p.cancel("Setup cancelled.");
        process.exit(1);
      }
    }
  } else {
    const newAuthPath = config.usesTypeScript ? `${authPath}.ts` : `${authPath}.js`;
    writeFileSync(newAuthPath, source);
    p.log.success(`Created ${newAuthPath}`);
  }
}

async function initializeHttp(config: ProjectConfig) {
  logStep(config, "Initialize HTTP auth routes");
  const sourceTemplate = `\
import { auth } from "./auth";

export default auth.http();
`;
  const source = templateToSource(sourceTemplate);
  const httpPath = path.join(config.convexFolderPath, "http");
  const existingPath = existingNonEmptySourcePath(httpPath);
  if (existingPath !== null) {
    const existing = readFileSync(existingPath, "utf8");
    if (doesAlreadyMatchTemplate(existing, sourceTemplate)) {
      p.log.success(`${existingPath} is already set up.`);
    } else {
      p.log.info(
        `You already have ${existingPath}. Make sure it mounts Convex Auth protocol routes:`,
      );
      p.log.message(indent(`\n${source}\n`));
      const ready = await p.confirm({ message: "Ready to continue?" });
      handleCancel(ready);
      if (!ready) {
        p.cancel("Setup cancelled.");
        process.exit(1);
      }
    }
  } else {
    const newPath = config.usesTypeScript ? `${httpPath}.ts` : `${httpPath}.js`;
    writeFileSync(newPath, source);
    p.log.success(`Created ${newPath}`);
  }
}

async function initializeAuthCore(config: ProjectConfig) {
  logStep(config, "Initialize auth/core file");
  const sourceTemplate = `\
import { createAuthContext } from "@robelest/convex-auth/core";
import { components } from "../_generated/api";

export const auth = createAuthContext(components.auth);
`;
  const source = templateToSource(sourceTemplate);
  const authDir = path.join(config.convexFolderPath, "auth");
  const corePath = path.join(authDir, "core");
  const existingPath = existingNonEmptySourcePath(corePath);
  if (existingPath !== null) {
    const existing = readFileSync(existingPath, "utf8");
    if (doesAlreadyMatchTemplate(existing, sourceTemplate)) {
      p.log.success(`${existingPath} is already set up.`);
    } else {
      p.log.info(`You already have ${existingPath}. Make sure it uses createAuthContext:`);
      p.log.message(indent(`\n${source}\n`));
      const ready = await p.confirm({ message: "Ready to continue?" });
      handleCancel(ready);
      if (!ready) {
        p.cancel("Setup cancelled.");
        process.exit(1);
      }
    }
  } else {
    if (!existsSync(authDir)) {
      mkdirSync(authDir, { recursive: true });
    }
    const newPath = config.usesTypeScript ? `${corePath}.ts` : `${corePath}.js`;
    writeFileSync(newPath, source);
    p.log.success(`Created ${newPath}`);
  }
}

async function initializeAuthConfig(config: ProjectConfig) {
  logStep(config, "Initialize auth.config file");
  const sourceTemplate = `\
import { env } from "./_generated/server";$$
$$
export default {$$
  providers: [$$
    {$$
      domain: \`\${env.CONVEX_SITE_URL}/auth\`,$$
      applicationID: "convex",$$
    },$$
  ],$$
};
`;
  const source = templateToSource(sourceTemplate);
  const authConfigPath = path.join(config.convexFolderPath, "auth.config");
  const existingPath = existingNonEmptySourcePath(authConfigPath);
  if (existingPath !== null) {
    const existing = readFileSync(existingPath, "utf8");
    if (doesAlreadyMatchTemplate(existing, sourceTemplate)) {
      p.log.success(`${existingPath} is already set up.`);
    } else {
      p.log.info(
        `You already have ${existingPath}. Make sure it trusts env.CONVEX_SITE_URL as the Convex auth issuer:`,
      );
      p.log.message(indent(`\n${source}\n`));
      const ready = await p.confirm({ message: "Ready to continue?" });
      handleCancel(ready);
      if (!ready) {
        p.cancel("Setup cancelled.");
        process.exit(1);
      }
    }
  } else {
    const newPath = config.usesTypeScript ? `${authConfigPath}.ts` : `${authConfigPath}.js`;
    writeFileSync(newPath, source);
    p.log.success(`Created ${newPath}`);
  }
}

type VariableEntry = {
  name: string;
  description: string;
};

type ProviderEntry = {
  name: string;
  help?: string;
  variables: VariableEntry[];
};

type VariablesConfig = {
  help?: string;
  providers: ProviderEntry[];
  success?: string;
};

function validateVariablesConfig(value: unknown): VariablesConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object at the top level.");
  }
  const obj = value as Record<string, unknown>;

  if (obj.help !== undefined && typeof obj.help !== "string") {
    throw new Error("'help' must be a string if present.");
  }
  if (obj.success !== undefined && typeof obj.success !== "string") {
    throw new Error("'success' must be a string if present.");
  }
  if (!Array.isArray(obj.providers)) {
    throw new Error("'providers' must be an array.");
  }

  const providers: ProviderEntry[] = [];
  for (const provider of obj.providers) {
    if (typeof provider !== "object" || provider === null) {
      throw new Error("Each provider must be an object.");
    }
    const prov = provider as Record<string, unknown>;
    if (typeof prov.name !== "string") {
      throw new Error("Each provider must have a 'name' string.");
    }
    if (prov.help !== undefined && typeof prov.help !== "string") {
      throw new Error("Provider 'help' must be a string if present.");
    }
    if (!Array.isArray(prov.variables)) {
      throw new Error("Each provider must have a 'variables' array.");
    }
    const variables: VariableEntry[] = [];
    for (const v of prov.variables) {
      if (typeof v !== "object" || v === null) {
        throw new Error("Each variable must be an object.");
      }
      const variable = v as Record<string, unknown>;
      if (typeof variable.name !== "string") {
        throw new Error("Each variable must have a 'name' string.");
      }
      if (typeof variable.description !== "string") {
        throw new Error("Each variable must have a 'description' string.");
      }
      variables.push({
        name: variable.name,
        description: variable.description,
      });
    }
    providers.push({
      name: prov.name,
      help: prov.help as string | undefined,
      variables,
    });
  }

  return {
    help: obj.help as string | undefined,
    providers,
    success: obj.success as string | undefined,
  };
}

async function configureOtherVariables(config: ProjectConfig, json: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    logErrorAndExit(
      "The --variables flag must be valid JSON.",
      err instanceof Error ? err.message : String(err),
    );
  }

  let variables: VariablesConfig;
  try {
    variables = validateVariablesConfig(parsed);
  } catch (err) {
    logErrorAndExit(
      "The --variables flag has an invalid shape.",
      err instanceof Error ? err.message : String(err),
    );
  }
  logStep(config, "Configure extra environment variables");
  if (variables.help !== undefined) {
    p.log.message(variables.help);
  }
  for (const provider of variables.providers) {
    const shouldConfigure = await p.confirm({
      message: `Configure ${provider.name}?`,
    });
    handleCancel(shouldConfigure);
    if (!shouldConfigure) {
      continue;
    }
    if (provider.help !== undefined) {
      p.log.message(provider.help);
    }
    for (const variable of provider.variables) {
      await configureEnvVar(config, {
        name: variable.name,
        description: variable.description,
      });
    }
  }
  if (variables.success !== undefined) {
    p.log.success(variables.success);
  }
}

/** @internal */
export function doesAlreadyMatchTemplate(existing: string, template: string) {
  const regex = new RegExp(
    template
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\$\\\$/g, ".*")
      .replace(/;\n/g, ";.*"),
    "s",
  );
  return regex.test(existing);
}

/** @internal */
export function templateToSource(template: string) {
  return template.replace(/\$\$/g, "");
}

function existingNonEmptySourcePath(filePath: string): string | null {
  return existsAndNotEmpty(`${filePath}.ts`)
    ? `${filePath}.ts`
    : existsAndNotEmpty(`${filePath}.js`)
      ? `${filePath}.js`
      : null;
}

function existsAndNotEmpty(filePath: string): boolean {
  return existsSync(filePath) && readFileSync(filePath, "utf8").trim() !== "";
}

function logStep(config: ProjectConfig, message: string) {
  p.log.step(`Step ${config.step++}: ${message}`);
}

async function checkSourceControl(options: {
  skipGitCheck?: boolean;
  allowDirtyGitState?: boolean;
}) {
  if (options.allowDirtyGitState) {
    return;
  }
  const isGit = existsSync(".git");
  if (isGit) {
    let gitStatus: string;
    try {
      gitStatus = execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf-8",
      });
    } catch {
      return;
    }
    const changedFiles = gitStatus
      .split("\n")
      .filter(
        (line) =>
          !/\bpackage(-lock)?.json/.test(line) && !/\benv\.d\.ts$/.test(line) && line.length > 0,
      );
    if (changedFiles.length > 0) {
      p.log.warn("There are unstaged or uncommitted changes in the working directory.");
      const cont = await p.confirm({
        message: "Continue anyway?",
        initialValue: false,
      });
      handleCancel(cont);
      if (!cont) {
        p.cancel("Setup cancelled.");
        process.exit(1);
      }
    }
  } else {
    if (options.skipGitCheck) {
      return;
    }
    p.log.warn("No source control detected. We recommend committing your current state first.");
    const cont = await p.confirm({ message: "Continue anyway?" });
    handleCancel(cont);
    if (!cont) {
      p.cancel("Setup cancelled.");
      process.exit(1);
    }
  }
}

type PackageJSON = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} & Record<string, unknown>;

function readPackageJson(): PackageJSON {
  try {
    const data = readFileSync("package.json", "utf8");
    return JSON.parse(data);
  } catch (error: unknown) {
    logErrorAndExit(
      "`@robelest/convex-auth` must be run from a project directory which " +
        'includes a valid "package.json" file. You can create one by running ' +
        "`npm init`.",
      error instanceof Error ? error.message : String(error),
    );
  }
}

type ConvexJSON = {
  functions?: string;
} & Record<string, unknown>;

function readConvexJson(): ConvexJSON {
  if (!existsSync("convex.json")) {
    return {} as ConvexJSON;
  }
  try {
    const data = readFileSync("convex.json", "utf8");
    return JSON.parse(data);
  } catch (error: unknown) {
    logErrorAndExit(
      "Could not parse your convex.json. Is it valid JSON?",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function loadEnvFiles() {
  loadEnvFile({ path: ".env.local", override: false });
  loadEnvFile({ path: ".env", override: false });
}

/** @internal */
export function readConvexDeployment(options: {
  url?: string;
  adminKey?: string;
  prod?: boolean;
  previewName?: string;
  deploymentName?: string;
}) {
  const { adminKey, url, prod, previewName, deploymentName } = options;

  if (url) {
    return { name: url, type: null, options };
  }

  const adminKeyName = adminKey ? deploymentNameFromAdminKey(adminKey) : null;
  const adminKeyType = adminKey ? deploymentTypeFromAdminKey(adminKey) : null;

  const explicitSelection = [
    prod ? { name: adminKeyName, type: "prod" as const } : null,
    previewName ? { name: previewName, type: "preview" as const } : null,
    deploymentName ? { name: deploymentName, type: adminKeyType } : null,
    adminKey ? { name: adminKeyName, type: adminKeyType } : null,
  ].find(
    (
      selection,
    ): selection is {
      name: string | null;
      type: string | null;
    } => selection !== null,
  );

  if (explicitSelection !== undefined) {
    return { ...explicitSelection, options };
  }

  loadEnvFiles();
  if (process.env.CONVEX_DEPLOYMENT) {
    const type = getDeploymentTypeFromConfiguredDeployment(process.env.CONVEX_DEPLOYMENT);
    return {
      name: stripDeploymentTypePrefix(process.env.CONVEX_DEPLOYMENT),
      type,
      options,
    };
  }

  logErrorAndExit(
    "Could not find a configured CONVEX_DEPLOYMENT. Did you forget to run `npx convex dev` first?",
  );
}

/** @internal */
export function stripDeploymentTypePrefix(deployment: string) {
  const [type, name] = deployment.split(":");
  if ((type !== "prod" && type !== "dev" && type !== "preview") || !name) {
    logErrorAndExit(
      "Invalid CONVEX_DEPLOYMENT.",
      'Expected a typed deployment like "dev:my-deployment", "prod:my-deployment", or "preview:my-deployment".',
    );
  }
  return name;
}

function getDeploymentTypeFromConfiguredDeployment(raw: string) {
  const typeRaw = raw.split(":")[0];
  if (typeRaw === "prod" || typeRaw === "dev" || typeRaw === "preview") {
    return typeRaw;
  }
  logErrorAndExit(
    "Invalid CONVEX_DEPLOYMENT.",
    'Expected a typed deployment like "dev:my-deployment", "prod:my-deployment", or "preview:my-deployment".',
  );
}

function deploymentNameFromAdminKey(adminKey: string) {
  const parts = adminKey.split("|");
  const hasDeployment = parts.length > 1;
  return hasDeployment && !isPreviewDeployKey(adminKey)
    ? stripDeploymentTypePrefix(parts[0])
    : null;
}

/** @internal */
export function deploymentTypeFromAdminKey(adminKey: string) {
  const type = adminKey.split(":")[0];
  if (type === "prod" || type === "dev" || type === "preview") {
    return type;
  }
  logErrorAndExit(
    "Invalid admin key.",
    'Expected a typed key like "dev:deployment|...", "prod:deployment|...", or "preview:...".',
  );
}

/** @internal */
export function isPreviewDeployKey(adminKey: string) {
  const parts = adminKey.split("|");
  if (parts.length === 1) {
    return false;
  }
  const [prefix] = parts;
  const prefixParts = prefix.split(":");
  return prefixParts[0] === "preview" && prefixParts.length === 3;
}

function printFinalSuccessMessage(config: ProjectConfig) {
  const isProd = config.deployment.type === "prod";
  const deploymentName = config.deployment.name ?? "your deployment";

  if (isProd) {
    p.log.success(`Production setup complete for ${deploymentName}.`);
    p.note("Full docs: https://auth.estifanos.com");
  } else {
    p.log.success(`Setup complete for ${deploymentName}.`);
    p.note(
      [
        "To set up production, run:",
        '  npx @robelest/convex-auth --prod --app-url "https://myapp.com"',
        "",
        "Don't forget to set provider secrets on production too:",
        '  npx convex env set --prod AUTH_GITHUB_ID "..."',
        '  npx convex env set --prod AUTH_GITHUB_SECRET "..."',
        "",
        "Full docs: https://auth.estifanos.com",
      ].join("\n"),
      "Next steps",
    );
  }
}

function logErrorAndExit(message: string, error?: string): never {
  p.log.error(`${message}${error !== undefined ? `\n  ${error}` : ""}`);
  process.exit(1);
}

function indent(string: string) {
  return string.replace(/^/gm, "  ").slice(2);
}
