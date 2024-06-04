#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
import chalk from "chalk";
import { execSync } from "child_process";
import { config as loadEnvFile } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "fs";
import inquirer from "inquirer";
import path from "path";
import { generateKeys } from "./generateKeys.js";
import { actionDescription } from "./command.js";

new Command()
  .name("@xixixao/convex-auth")
  .description(
    "Add code and set environment variables for @xixixao/convex-auth.\n\n" +
      "The steps are detailed here: https://labs.convex.dev/auth/setup/manual",
  )
  .addDeploymentSelectionOptions(
    actionDescription("Set environment variables on"),
  )
  .action(async (options) => {
    await checkSourceControl();

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
    const config = {
      isNextjs,
      usesTypeScript,
      isVite,
      convexFolderPath,
      deployment,
      step: 1,
    };

    // Step 1: Configure SITE_URL
    // We check for existing config.
    // We default to localhost and port depending on framework
    await configureSiteUrl(config);

    // Step 2: Configure private and public key
    // We ask if we would overwrite existing keys
    await configureKeys(config);

    // Step 3: Change moduleResolution to "bundler"
    // Skipped if there's no tsconfig.json
    await changeModuleResolution(config);

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

    logSuccess(
      "You're all set. Continue by configuring your schema and frontend.",
    );
  })
  .parse(process.argv);

type ProjectConfig = {
  isNextjs: boolean;
  usesTypeScript: boolean;
  isVite: boolean;
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

async function configureSiteUrl(config: ProjectConfig) {
  logStep(config, "Configure SITE_URL");
  const existing = await backendEnvVar(config, "SITE_URL");
  // Default to localhost for dev and also for local backend
  // this is not perfect but OK since it's just the default.
  const value =
    config.deployment.type === "dev" || config.deployment.type === null
      ? config.isVite
        ? "http://localhost:5173"
        : "http://localhost:3000"
      : undefined;
  if (existing !== "") {
    if (
      !(await promptForConfirmation(
        `The ${printDeployment(config)} already has SITE_URL configured to ${chalk.bold(existing)}. Do you want to change it?`,
        { default: false },
      ))
    ) {
      return;
    }
  }
  const description =
    config.deployment.type === "dev"
      ? "the origin of your local web server (e.g. http://localhost:1234)"
      : "the origin where your site is hosted (e.g. https://example.com)";
  const chosenValue = await promptForInput(`Enter ${description}`, {
    default: value,
    validate: (input) => {
      try {
        const url = new URL(input);
        if (url.pathname !== "/") {
          return "The URL must be an origin without any path, like http://localhost:1234 or https://example.com";
        }
        return true;
      } catch (error: any) {
        return "The URL must start with http:// or https://";
      }
    },
  });
  await setEnvVar(config, "SITE_URL", new URL(chosenValue).origin);
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
  execSync(
    `npx convex env set ${deploymentOptions(config)} -- ${name} '${value}'`,
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

async function changeModuleResolution(config: ProjectConfig) {
  logStep(config, "Change moduleResolution to Bundler");
  const tsConfigPath = path.join(config.convexFolderPath, "tsconfig.json");
  if (!existsSync(tsConfigPath)) {
    logInfo(
      `No ${chalk.bold(tsConfigPath)} found. Skipping \`moduleResolution\` change.`,
    );
    return;
  }
  const existingTsConfig = readFileSync(tsConfigPath, "utf8");
  if (/"moduleResolution"\s*:\s*"Bundler"/i.test(existingTsConfig)) {
    logSuccess(`The ${chalk.bold(tsConfigPath)} is already set up.`);
    return;
  }
  const pattern = /"moduleResolution"\s*:\s*"\w+"/;
  if (!pattern.test(existingTsConfig)) {
    logInfo(
      `Modify your ${chalk.bold(tsConfigPath)} to include the following:`,
    );
    const source = `\
  {
    "compilerOptions": {
      "moduleResolution": "Bundler"
    }
  }
    `;
    console.error(indent(`\n${source}\n`));
    await promptForConfirmationOrExit("Ready to continue?");
  }
  const changedTsConfig = existingTsConfig.replace(
    pattern,
    '"moduleResolution": "Bundler"',
  );
  writeFileSync(tsConfigPath, changedTsConfig);
  logSuccess(`Modified ${chalk.bold(tsConfigPath)}`);
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
      console.error(indent(`\n${source}\n`));
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
import { convexAuth } from "@xixixao/convex-auth/server";

export const { auth, signIn, verifyCode, signOut, store } = convexAuth({$$
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
      console.error(indent(`\n${source}\n`));
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
      console.error(indent(`\n${source}\n`));
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
    console.error();
  }
  logInfo(chalk.bold(`Step ${config.step++}: ${message}`));
}

async function checkSourceControl() {
  const isGit = existsSync(".git");
  if (isGit) {
    const gitStatus = execSync("git status --porcelain").toString();
    if (gitStatus) {
      logError(
        "There are unstaged or uncommitted changes in the working directory. " +
          "Please commit or stash them before proceeding.",
      );
      await promptForConfirmationOrExit("Continue anyway?", { default: false });
    }
  } else {
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
      "`@xixixao/convex-auth` must be run from a project directory which " +
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
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: "confirm",
      name: "confirmed",
      message,
      default: options.default ?? true,
    },
  ]);
  return confirmed;
}

async function promptForInput(
  message: string,
  options: { default?: string; validate?: (input: string) => true | string },
) {
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
}

function logErrorAndExit(message: string, error?: string): never {
  logError(message, error);
  process.exit(1);
}

function logError(message: string, error?: string) {
  console.error(
    `${chalk.red(`✖`)} ${indent(message)}${
      error !== undefined ? `\n  ${chalk.grey(`Error: ${indent(error)}`)}` : ""
    }`,
  );
}

function logWarning(message: string) {
  console.warn(`${chalk.yellow.bold(`!`)} ${indent(message)}`);
}

function logInfo(message: string) {
  console.error(`${chalk.blue.bold(`i`)} ${indent(message)}`);
}

function logSuccess(message: string) {
  console.error(`${chalk.green(`✔`)} ${indent(message)}`);
}

function indent(string: string) {
  return string.replace(/^/gm, "  ").slice(2);
}
