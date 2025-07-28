#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
import chalk from "chalk";
import { execSync } from "child_process";
import { config as loadEnvFile } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "fs";
import inquirer from "inquirer";
import path from "path";
import * as v from "valibot";
import { actionDescription } from "./command.js";
import { generateKeys } from "./generateKeys.js";

new Command()
  .name("@convex-dev/auth")
  .description(
    "Add code and set environment variables for @convex-dev/auth.\n\n" +
      "The steps are detailed here: https://labs.convex.dev/auth/setup/manual",
  )
  .option(
    "--variables <json>",
    "Configure additional variables for interactive configuration.",
  )
  .option("--skip-git-check", "Don't warn when running outside a Git checkout.")
  .option("--allow-dirty-git-state", "Don't warn when Git state is not clean.")
  .option(
    "--web-server-url <url>",
    "URL of web server, e.g. 'http://localhost:5173' if local",
  )
  .addDeploymentSelectionOptions(
    actionDescription("Set environment variables on"),
  )
  .action(async (options) => {
    await checkSourceControl(options);

    const packageJson = readPackageJson();
    const convexJson = readConvexJson();
    const deployment = readConvexDeployment(options);
    const convexFolderPath = convexJson.functions ?? "convex";

    const isNextjs = !!packageJson.dependencies?.next;
    const usesTypeScript = !!(
      packageJson.dependencies?.typescript ||
      packageJson.devDependencies?.typescript
    );
    const isVite = !!(
      packageJson.dependencies?.vite || packageJson.devDependencies?.vite
    );
    const isExpo = !!(
      packageJson.dependencies?.expo || packageJson.devDependencies?.expo
    );
    const config = {
      isNextjs,
      isVite,
      isExpo,
      usesTypeScript,
      convexFolderPath,
      deployment,
      step: 1,
    };

    // Step 1: Configure SITE_URL
    // We check for existing config.
    // We default to localhost and port depending on framework
    await configureSiteUrl(config, options.webServerUrl);

    // Step 2: Configure private and public key
    // We ask if we would overwrite existing keys
    await configureKeys(config);

    // Step 3: Change moduleResolution to "bundler"
    // and turn on skipLibCheck
    // Skipped if there's no tsconfig.json
    await modifyTsConfig(config);

    // Step 4: Configure auth.config.ts
    // To avoid having to execute it we just give instructions
    // if it exists already.
    await configureAuthConfig(config);

    // Step 5: Initialize auth.ts
    // We do nothing if the file already contains the code,
    // and give instructions otherwise
    await initializeAuth(config);

    // Step 6: Configure http.ts
    // We do nothing if the file already contains the code,
    // and give instructions otherwise
    await configureHttp(config);

    // Extra: Configure providers interactively.
    if (options.variables !== undefined) {
      await configureOtherVariables(config, options.variables);
    } else {
      logSuccess(
        "You're all set. Continue by configuring your schema and frontend.",
      );
    }
  })
  .parse(process.argv);

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
  // Mutated along the way
  step: number;
};

async function configureSiteUrl(config: ProjectConfig, forcedValue?: string) {
  logStep(config, "Configure SITE_URL");
  if (config.isExpo) {
    logInfo("React Native projects don't require a SITE_URL.");
    return;
  }

  // Default to localhost for dev and also for local backend
  // this is not perfect but OK since it's just the default.
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
    name: "SITE_URL",
    default: value,
    description,
    validate: (input) => {
      try {
        new URL(input);
        return true;
      } catch (error: any) {
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
    validate?: (input: string) => true | string;
    forcedValue?: string;
  },
) {
  if (
    variable.forcedValue &&
    (variable.validate ? variable.validate(variable.forcedValue) : true)
  ) {
    await setEnvVar(config, variable.name, variable.forcedValue);
    return;
  }
  const existing = await backendEnvVar(config, variable.name);
  if (existing !== "") {
    if (
      !(await promptForConfirmation(
        `The ${printDeployment(config)} already has ${variable.name} configured to ${chalk.bold(existing)}. Do you want to change it?`,
        { default: false },
      ))
    ) {
      return;
    }
  }
  const chosenValue = await promptForInput(`Enter ${variable.description}`, {
    default: variable.default,
    validate: variable.validate,
  });
  await setEnvVar(config, variable.name, chosenValue);
}

async function configureKeys(config: ProjectConfig) {
  logStep(config, "Configure private and public key");
  const { JWT_PRIVATE_KEY, JWKS } = await generateKeys();
  // TODO: We should just list all the 3 env vars in one command
  // to speed things up, but the convex CLI doesn't quote the
  // values correctly right now, so we can't.
  const existingPrivateKey = await backendEnvVar(config, "JWT_PRIVATE_KEY");
  const existingJwks = await backendEnvVar(config, "JWKS");
  if (existingPrivateKey !== "" || existingJwks !== "") {
    if (
      !(await promptForConfirmation(
        `The ${printDeployment(config)} already has JWT_PRIVATE_KEY or JWKS configured. Overwrite them?`,
        { default: false },
      ))
    ) {
      return;
    }
  }
  // TODO: We should set both env vars in one command, but the convex CLI doesn't
  // support setting multiple env vars.
  await setEnvVar(config, "JWT_PRIVATE_KEY", JWT_PRIVATE_KEY, {
    hideValue: true,
  });
  await setEnvVar(config, "JWKS", JWKS, { hideValue: true });
}

async function backendEnvVar(config: ProjectConfig, name: string) {
  return (
    execSync(`npx convex env get ${deploymentOptions(config)} ${name}`, {
      stdio: "pipe",
    })
      .toString()
      // Remove trailing newline
      .slice(0, -1)
  );
}

async function setEnvVar(
  config: ProjectConfig,
  name: string,
  value: string,
  options?: { hideValue: boolean },
) {
  const valueEscaped = value.replace(/"/g, '\\"');
  execSync(
    `npx convex env set ${deploymentOptions(config)} -- ${name} "${valueEscaped}"`,
    {
      stdio: options?.hideValue ? "ignore" : "inherit",
    },
  );
  if (options?.hideValue) {
    logSuccess(
      `Successfully set ${chalk.bold(name)} (on ${printDeployment(config)})`,
    );
  }
}

function deploymentOptions(config: ProjectConfig) {
  const {
    deployment: {
      options: { adminKey },
    },
  } = config;
  const adminKeyOption =
    adminKey !== undefined ? `--admin-key '${adminKey}' ` : "";
  return adminKeyOption + deploymentNameOptions(config);
}

function deploymentNameOptions(config: ProjectConfig) {
  const {
    deployment: {
      options: { url, prod, previewName, deploymentName },
    },
  } = config;
  if (url) {
    return `--url ${url}`;
  } else if (prod) {
    return "--prod";
  } else if (previewName) {
    return `--preview-name ${previewName}`;
  } else if (deploymentName) {
    return `--deployment-name ${deploymentName}`;
  } else {
    return "";
  }
}

function printDeployment(config: ProjectConfig) {
  const { name, type } = config.deployment;
  return (
    (type !== null ? `${chalk.bold(type)} ` : "") +
    "deployment" +
    (name !== null ? ` ${chalk.bold(name)}` : "")
  );
}

// Match `"compilerOptions": {"`
// ignore comments after the bracket
// and capture the space between the bracket/last comment
// and the quote.
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
        logSuccess(`Added ${chalk.bold(tsConfigPath)}`);
        return;
      }
      // else assume that the project-level tsconfig already
      // has the right settings, which is true for Vite and Next.js
    }
    logInfo(`No ${chalk.bold(tsConfigPath)} found. Skipping.`);
    return;
  }
  const existingTsConfig = readFileSync(tsConfigPath, "utf8");
  const moduleResolutionPattern = /"moduleResolution"\s*:\s*"(\w+)"/;
  const [, existingModuleResolution] =
    existingTsConfig.match(moduleResolutionPattern) ?? [];
  const skipLibCheckPattern = /"skipLibCheck"\s*:\s*(\w+)/;
  const [, existingSkipLibCheck] =
    existingTsConfig.match(skipLibCheckPattern) ?? [];
  if (
    /Bundler/i.test(existingModuleResolution) &&
    existingSkipLibCheck === "true"
  ) {
    logSuccess(`The ${chalk.bold(tsConfigPath)} is already set up.`);
    return;
  }

  if (!compilerOptionsPattern.test(existingTsConfig)) {
    logInfo(
      `Modify your ${chalk.bold(tsConfigPath)} to include the following:`,
    );
    const source = `\
  {
    "compilerOptions": {
      "moduleResolution": "Bundler",
      "skipLibCheck": true
    }
  }
    `;
    print(indent(`\n${source}\n`));
    await promptForConfirmationOrExit("Ready to continue?");
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
  logSuccess(`Modified ${chalk.bold(tsConfigPath)}`);
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

async function configureAuthConfig(config: ProjectConfig) {
  logStep(config, "Configure auth config file");
  const sourceTemplate = `\
export default {
  providers: [$$
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },$$
  ],
};
`;
  const source = templateToSource(sourceTemplate);
  const authConfigPath = path.join(config.convexFolderPath, "auth.config");
  const existingConfigPath = await existingNonEmptySourcePath(authConfigPath);
  if (existingConfigPath !== null) {
    const existingConfig = readFileSync(existingConfigPath, "utf8");
    if (doesAlreadyMatchTemplate(existingConfig, sourceTemplate)) {
      logSuccess(`The ${chalk.bold(existingConfigPath)} is already set up.`);
    } else {
      logInfo(
        `You already have a ${chalk.bold(existingConfigPath)}, make sure the \`providers\` include the following config:`,
      );
      print(indent(`\n${source}\n`));
      await promptForConfirmationOrExit("Ready to continue?");
    }
  } else {
    const newConfigPath = config.usesTypeScript
      ? `${authConfigPath}.ts`
      : `${authConfigPath}.js`;
    writeFileSync(newConfigPath, source);
    logSuccess(`Created ${chalk.bold(newConfigPath)}`);
  }
}

async function initializeAuth(config: ProjectConfig) {
  logStep(config, "Initialize auth file");
  const sourceTemplate = `\
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({$$
  providers: [$$],$$
});
`;
  const source = templateToSource(sourceTemplate);
  const authPath = path.join(config.convexFolderPath, "auth");
  const existingAuthPath = await existingNonEmptySourcePath(authPath);
  if (existingAuthPath !== null) {
    const existingAuth = readFileSync(existingAuthPath, "utf8");
    if (doesAlreadyMatchTemplate(existingAuth, sourceTemplate)) {
      logSuccess(`The ${chalk.bold(existingAuthPath)} is already set up.`);
    } else {
      logInfo(
        `You already have a ${chalk.bold(existingAuthPath)}, make sure it initializes \`convexAuth\` like this:`,
      );
      print(indent(`\n${source}\n`));
      await promptForConfirmationOrExit("Ready to continue?");
    }
  } else {
    const newAuthPath = config.usesTypeScript
      ? `${authPath}.ts`
      : `${authPath}.js`;
    writeFileSync(newAuthPath, source);
    logSuccess(`Created ${chalk.bold(newAuthPath)}`);
  }
}

async function configureHttp(config: ProjectConfig) {
  logStep(config, "Configure http file");
  const sourceTemplate = `\
import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

export default http;
`;
  const source = templateToSource(sourceTemplate);
  const httpPath = path.join(config.convexFolderPath, "http");
  const existingHttpPath = await existingNonEmptySourcePath(httpPath);
  if (existingHttpPath !== null) {
    const existingHttp = readFileSync(existingHttpPath, "utf8");
    if (doesAlreadyMatchTemplate(existingHttp, sourceTemplate)) {
      logSuccess(`The ${chalk.bold(existingHttpPath)} is already set up.`);
    } else {
      logInfo(
        `You already have a ${chalk.bold(existingHttpPath)}, make sure it includes the call to \`auth.addHttpRoutes\`:`,
      );
      print(indent(`\n${source}\n`));
      await promptForConfirmationOrExit("Ready to continue?");
    }
  } else {
    const newHttpPath = config.usesTypeScript
      ? `${httpPath}.ts`
      : `${httpPath}.js`;
    writeFileSync(newHttpPath, source);
    logSuccess(`Created ${chalk.bold(newHttpPath)}`);
  }
}

const VariablesSchema = v.object({
  help: v.optional(v.string()),
  providers: v.array(
    v.object({
      name: v.string(),
      help: v.optional(v.string()),
      variables: v.array(
        v.object({
          name: v.string(),
          description: v.string(),
        }),
      ),
    }),
  ),
  success: v.optional(v.string()),
});

async function configureOtherVariables(config: ProjectConfig, json: string) {
  const variables = v.parse(VariablesSchema, JSON.parse(json));
  logStep(config, "Configure extra environment variables");
  // Ex: The default setup includes sign-in with GitHub OAuth
  // and sending magic links via Resend.
  if (variables.help !== undefined) {
    print(variables.help);
  }
  for (const provider of variables.providers) {
    if (
      !(await promptForConfirmation(
        `Do you want to configure ${provider.name}?`,
      ))
    ) {
      continue;
    }
    if (provider.help !== undefined) {
      print(provider.help);
    }
    for (const variable of provider.variables) {
      await configureEnvVar(config, {
        name: variable.name,
        description: variable.description,
      });
    }
  }
  if (variables.success !== undefined) {
    logSuccess(variables.success);
  }
}

function doesAlreadyMatchTemplate(existing: string, template: string) {
  const regex = new RegExp(
    template
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\$\\\$/g, ".*")
      .replace(/;\n/g, ";.*"),
    "s",
  );
  return regex.test(existing);
}

function templateToSource(template: string) {
  return template.replace(/\$\$/g, "");
}

async function existingNonEmptySourcePath(path: string) {
  return (await existsAndNotEmpty(`${path}.ts`))
    ? `${path}.ts`
    : (await existsAndNotEmpty(`${path}.js`))
      ? `${path}.js`
      : null;
}

async function existsAndNotEmpty(path: string) {
  return existsSync(path) && readFileSync(path, "utf8").trim() !== "";
}

function logStep(config: ProjectConfig, message: string) {
  if (config.step > 1) {
    print();
  }
  logInfo(chalk.bold(`Step ${config.step++}: ${message}`));
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
    const gitStatus = execSync("git status --porcelain").toString();
    const changedFiles = gitStatus
      .split("\n")
      .filter(
        (line) => !/\bpackage(-lock)?.json/.test(line) && line.length > 0,
      );
    if (changedFiles.length > 0) {
      logError(
        "There are unstaged or uncommitted changes in the working directory. " +
          "Please commit or stash them before proceeding.",
      );
      await promptForConfirmationOrExit("Continue anyway?", { default: false });
    }
  } else {
    if (options.skipGitCheck) {
      return;
    }
    logWarning(
      "No source control detected. We strongly recommend committing the current state of your code before proceeding.",
    );
    await promptForConfirmationOrExit("Continue anyway?");
  }
}

type PackageJSON = { __isPackageJSON: true; [key: string]: any };

function readPackageJson(): PackageJSON {
  try {
    const data = readFileSync("package.json", "utf8");
    return JSON.parse(data);
  } catch (error: any) {
    logErrorAndExit(
      "`@convex-dev/auth` must be run from a project directory which " +
        'includes a valid "package.json" file. You can create one by running ' +
        "`npm init`.",
      error.message,
    );
  }
}

type ConvexJSON = { __isConvexJSON: true; [key: string]: any };

function readConvexJson(): ConvexJSON {
  if (!existsSync("convex.json")) {
    return {} as ConvexJSON;
  }
  try {
    const data = readFileSync("convex.json", "utf8");
    return JSON.parse(data);
  } catch (error: any) {
    logErrorAndExit(
      "Could not parse your convex.json. Is it valid JSON?",
      error.message,
    );
  }
}

function readConvexDeployment(options: {
  url?: string;
  adminKey?: string;
  prod?: boolean;
  previewName?: string;
  deploymentName?: string;
}) {
  const { adminKey, url, prod, previewName, deploymentName } = options;
  const adminKeyName = adminKey ? deploymentNameFromAdminKey(adminKey) : null;
  const adminKeyType = adminKey ? deploymentTypeFromAdminKey(adminKey) : null;
  if (url) {
    return { name: adminKeyName ?? url, type: adminKeyType, options };
  } else if (prod) {
    return { name: adminKeyName, type: "prod", options };
  }
  if (previewName) {
    return { name: previewName, type: "preview", options };
  }
  if (deploymentName) {
    return { name: deploymentName, type: adminKeyType, options };
  }
  if (adminKey) {
    return { name: adminKeyName, type: adminKeyType, options };
  }
  loadEnvFile({ path: ".env.local" });
  loadEnvFile();
  if (process.env.CONVEX_DEPLOYMENT) {
    return {
      name: stripDeploymentTypePrefix(process.env.CONVEX_DEPLOYMENT),
      type: getDeploymentTypeFromConfiguredDeployment(
        process.env.CONVEX_DEPLOYMENT,
      ),
      options,
    };
  }

  logErrorAndExit(
    "Could not find a configured CONVEX_DEPLOYMENT. Did you forget to run `npx convex dev` first?",
  );
}

// NOTE: CONVEX CLI DEP
// Given a deployment string like "dev:tall-forest-1234"
// returns only the slug "tall-forest-1234".
// If there's no prefix returns the original string.
export function stripDeploymentTypePrefix(deployment: string) {
  return deployment.split(":").at(-1)!;
}

// NOTE: CONVEX CLI DEP
// Handling legacy CONVEX_DEPLOYMENT without type prefix as well
function getDeploymentTypeFromConfiguredDeployment(raw: string) {
  const typeRaw = raw.split(":")[0];
  const type =
    typeRaw === "prod" || typeRaw === "dev" || typeRaw === "preview"
      ? typeRaw
      : null;
  return type;
}

// NOTE: CONVEX CLI DEP
function deploymentNameFromAdminKey(adminKey: string) {
  const parts = adminKey.split("|");
  if (parts.length === 1) {
    return null;
  }
  if (isPreviewDeployKey(adminKey)) {
    // Preview deploy keys do not contain a deployment name.
    return null;
  }
  return stripDeploymentTypePrefix(parts[0]);
}

// NOTE: CONVEX CLI DEP - but modified to not default to "prod"
//
// For current keys returns prod|dev|preview,
// for legacy keys returns "prod".
// Examples:
//  "prod:deploymentName|key" -> "prod"
//  "preview:deploymentName|key" -> "preview"
//  "dev:deploymentName|key" -> "dev"
//  "key" -> "prod"
export function deploymentTypeFromAdminKey(adminKey: string) {
  const parts = adminKey.split(":");
  if (parts.length === 1) {
    return null;
  }
  return parts.at(0)!;
}

// NOTE: CONVEX CLI DEP
// Needed to differentiate a preview deploy key
// from a concrete preview deployment's deploy key.
// preview deploy key: `preview:team:project|key`
// preview deployment's deploy key: `preview:deploymentName|key`
export function isPreviewDeployKey(adminKey: string) {
  const parts = adminKey.split("|");
  if (parts.length === 1) {
    return false;
  }
  const [prefix] = parts;
  const prefixParts = prefix.split(":");
  return prefixParts[0] === "preview" && prefixParts.length === 3;
}

async function promptForConfirmationOrExit(
  message: string,
  options: { default?: boolean } = {},
) {
  if (!(await promptForConfirmation(message, options))) {
    process.exit(1);
  }
}

async function promptForConfirmation(
  message: string,
  options: { default?: boolean } = {},
) {
  if (process.stdout.isTTY) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message,
        default: options.default ?? true,
      },
    ]);
    return confirmed;
  } else {
    return options.default ?? true;
  }
}

async function promptForInput(
  message: string,
  options: { default?: string; validate?: (input: string) => true | string },
) {
  if (process.stdout.isTTY) {
    const { input } = await inquirer.prompt<{ input: string }>([
      {
        type: "input",
        name: "input",
        message,
        default: options.default,
        validate: options.validate,
      },
    ]);
    return input;
  } else {
    if (options.default !== undefined) {
      return options.default;
    } else {
      logErrorAndExit(
        "Run this command in an interactive terminal to provide input.",
      );
    }
  }
}

function logErrorAndExit(message: string, error?: string): never {
  logError(message, error);
  process.exit(1);
}

function logError(message: string, error?: string) {
  print(
    `${chalk.red(`✖`)} ${indent(message)}${
      error !== undefined ? `\n  ${chalk.grey(`Error: ${indent(error)}`)}` : ""
    }`,
  );
}

function logWarning(message: string) {
  print(`${chalk.yellow.bold(`!`)} ${indent(message)}`);
}

function logInfo(message: string) {
  print(`${chalk.blue.bold(`i`)} ${indent(message)}`);
}

function logSuccess(message: string) {
  print(`${chalk.green(`✔`)} ${indent(message)}`);
}

function print(message?: string) {
  process.stderr.write((message ?? "") + "\n");
}

function indent(string: string) {
  return string.replace(/^/gm, "  ").slice(2);
}
