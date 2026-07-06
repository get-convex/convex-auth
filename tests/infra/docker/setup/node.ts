// fallow-ignore-file unused-file
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { api } from "@convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const execFileAsync = promisify(execFile);
const repoRoot = path.join(import.meta.dirname, "../../../..");
const composePath = path.join(repoRoot, "tests/infra/docker/compose.yml");
const composeEnvPath = path.join(repoRoot, "tests/infra/docker/test.env");
const runtimeDir = path.join(repoRoot, ".tmp");
const buildReadyFile = path.join(runtimeDir, "full-test-build-ready");
const envLocalPath = path.join(repoRoot, ".env.local");
const envLocalBackupPath = path.join(repoRoot, ".env.local.test-backup");
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_CONVEX_TIMEOUT_MS = 300_000;
const composeEnvDefaults = Object.fromEntries(
  readFileSync(composeEnvPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

declare module "vite-plus/test" {
  interface ProvidedContext {
    zitadelAdminPat: string;
    zitadelLoginClientPat: string;
    zitadelPublicUrl: string;
    zitadelInternalUrl: string;
    convexSelfHostedUrl: string;
    convexSiteUrl: string;
    jwtPrivateKey: string;
  }
}

export default async function setupNodeInterop(project: {
  provide: (key: string, value: string) => void;
}) {
  const waitTimeoutMs = envNumber("ZITADEL_WAIT_TIMEOUT_MS", DEFAULT_WAIT_TIMEOUT_MS);
  const convexTimeoutMs = envNumber("ZITADEL_CONVEX_RUN_TIMEOUT_MS", DEFAULT_CONVEX_TIMEOUT_MS);
  const generated = await generateKeys();
  const env = {
    ...baseEnv(),
    AUTH_SECRET_ENCRYPTION_KEY: "test-auth-secret-encryption-key",
    JWT_PRIVATE_KEY: generated.jwtPrivateKey,
    JWKS: generated.jwks,
  };

  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });
  try {
    await run("docker", composeArgs("down", "-v"), composeEnv());
  } catch {}

  try {
    await run(
      "docker",
      composeArgs(
        "--profile",
        "interop",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        String(Math.ceil(waitTimeoutMs / 1000)),
      ),
      composeEnv(),
      { timeout: waitTimeoutMs },
    );

    const { stdout, stderr } = await capture(
      "docker",
      composeArgs("exec", "-T", "backend", "/convex/generate_admin_key.sh"),
      composeEnv(),
    );
    const adminKey = parseAdminKey(`${stdout}\n${stderr}`);
    const convexEnv = selfHostedConvexEnv(adminKey);
    const buildEnv: NodeJS.ProcessEnv = { ...env, ...convexEnv };
    delete buildEnv.CONVEX_DEPLOYMENT;
    const envLocalWasHidden = await hideEnvLocalForSelfHostedCommands();
    const pemPath = path.join(runtimeDir, "jwt-private-key.pem");
    try {
      if (!(await fileExists(buildReadyFile))) {
        await run("vp", ["run", "cache:build:convex-codegen"], buildEnv, {
          timeout: convexTimeoutMs,
        });
        await run("vp", ["run", "cache:build:auth"], buildEnv, {
          timeout: convexTimeoutMs,
        });
      }
      await run("vp", ["exec", "convex", "deploy", "--yes"], convexEnv, {
        timeout: convexTimeoutMs,
      });
      await run("vp", ["exec", "convex", "env", "set", "APP_URL", env.APP_URL], convexEnv);
      await run("vp", ["exec", "convex", "env", "set", "AUTH_EMAIL", env.AUTH_EMAIL], convexEnv);
      await run(
        "vp",
        [
          "exec",
          "convex",
          "env",
          "set",
          "AUTH_SECRET_ENCRYPTION_KEY",
          env.AUTH_SECRET_ENCRYPTION_KEY,
        ],
        convexEnv,
      );
      await writeFile(pemPath, generated.jwtPrivateKey + "\n");
      await run(
        "vp",
        ["exec", "convex", "env", "set", "JWT_PRIVATE_KEY", "--from-file", pemPath],
        convexEnv,
      );
      await run("vp", ["exec", "convex", "env", "set", "JWKS", generated.jwks], convexEnv);
      await run(
        "vp",
        ["exec", "convex", "env", "set", "AUTH_GOOGLE_ID", env.AUTH_GOOGLE_ID],
        convexEnv,
      );
      await run(
        "vp",
        ["exec", "convex", "env", "set", "AUTH_GOOGLE_SECRET", env.AUTH_GOOGLE_SECRET],
        convexEnv,
      );
      await run(
        "vp",
        ["exec", "convex", "env", "set", "RESEND_API_KEY", env.RESEND_API_KEY],
        convexEnv,
      );
      await warmUpAnonymousSignIn(env.TEST_TARGET_BASE_URL, convexTimeoutMs);
    } finally {
      await rm(pemPath, { force: true });
      await restoreEnvLocalAfterSelfHostedCommands(envLocalWasHidden);
    }

    project.provide(
      "zitadelAdminPat",
      await readFileFromZitadel("/zitadel/bootstrap/admin.pat", waitTimeoutMs),
    );
    project.provide(
      "zitadelLoginClientPat",
      await readFileFromZitadel("/zitadel/bootstrap/login-client.pat", waitTimeoutMs),
    );
    project.provide("zitadelPublicUrl", env.ZITADEL_BASE_URL);
    project.provide("zitadelInternalUrl", env.ZITADEL_RUNTIME_BASE_URL);
    project.provide("convexSelfHostedUrl", env.TEST_TARGET_BASE_URL);
    project.provide("convexSiteUrl", `${env.CONVEX_SITE_URL.replace(/\/$/, "")}/auth`);
    project.provide("jwtPrivateKey", generated.jwtPrivateKey);
  } catch (error) {
    await dumpDockerLogs();
    throw error;
  }

  return async () => {
    try {
      await run("docker", composeArgs("down", "-v"), composeEnv());
    } catch {}
  };
}

function baseEnv() {
  return {
    ...process.env,
    AUTH_LOG_LEVEL: "DEBUG",
    TEST_TARGET_BASE_URL: "http://127.0.0.1:3210",
    CONVEX_SITE_URL: "http://127.0.0.1:3211",
    APP_URL: "http://localhost:5173",
    AUTH_EMAIL: "test@example.com",
    AUTH_GOOGLE_ID: "test-google-client-id",
    AUTH_GOOGLE_SECRET: "test-google-client-secret",
    RESEND_API_KEY: "test-resend-api-key",
    ZITADEL_BASE_URL: "http://127.0.0.1:8080",
    ZITADEL_RUNTIME_BASE_URL: "http://zitadel:8080",
  };
}

function composeEnv() {
  return {
    ...baseEnv(),
    ...composeEnvDefaults,
  };
}

function selfHostedConvexEnv(adminKey: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CONVEX_SELF_HOSTED_URL: baseEnv().TEST_TARGET_BASE_URL,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };
  delete env.CONVEX_DEPLOYMENT;
  return env;
}

function composeArgs(...args: string[]) {
  return ["compose", "--env-file", composeEnvPath, "-f", composePath, ...args];
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { timeout?: number } = {},
) {
  const child = execFile(command, args, {
    cwd: repoRoot,
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout,
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function capture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { timeout?: number } = {},
) {
  return await execFileAsync(command, args, {
    cwd: repoRoot,
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout,
  });
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function hideEnvLocalForSelfHostedCommands() {
  try {
    await access(envLocalPath);
  } catch {
    return false;
  }
  await rename(envLocalPath, envLocalBackupPath);
  return true;
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function restoreEnvLocalAfterSelfHostedCommands(wasHidden: boolean) {
  if (wasHidden) {
    await rename(envLocalBackupPath, envLocalPath);
  }
}

async function generateKeys() {
  const keys = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const privateKey = await exportPKCS8(keys.privateKey);
  const publicKey = await exportJWK(keys.publicKey);
  return {
    jwtPrivateKey: privateKey.trim(),
    jwks: JSON.stringify({ keys: [{ use: "sig", ...publicKey }] }),
  };
}

async function warmUpAnonymousSignIn(baseUrl: string, timeoutMs: number) {
  const convexClient = new ConvexHttpClient(baseUrl, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  });
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = (await convexClient.action(api.auth.signIn, {
        provider: "anonymous",
      })) as { kind?: string };
      if (result.kind === "signedIn") {
        return;
      }
      lastError = new Error(
        `Anonymous sign-in warm-up returned unexpected kind: ${String(result.kind)}`,
      );
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `Timed out warming up anonymous sign-in: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function dumpDockerLogs() {
  console.log("\n=== Docker Compose Status ===");
  try {
    await run("docker", composeArgs("ps"), composeEnv());
    console.log("\n=== Docker Compose Logs ===");
    await run("docker", composeArgs("logs", "--no-color", "--since=10m"), composeEnv());
  } catch (error) {
    console.error("Failed to print Docker logs", error);
  }
}

function parseAdminKey(output: string) {
  const match = output.match(/convex-self-hosted\|[A-Za-z0-9]+/);
  if (!match) {
    throw new Error(`Unable to parse self-hosted admin key from output:\n${output}`);
  }
  return match[0];
}

async function readFileFromZitadel(remotePath: string, timeoutMs: number) {
  const { stdout: idOut } = await capture(
    "docker",
    composeArgs("ps", "-q", "zitadel"),
    composeEnv(),
  );
  const containerId = idOut.trim();
  if (!containerId) throw new Error("Could not find the running zitadel container.");
  const { stdout: volumeOut } = await capture(
    "docker",
    [
      "inspect",
      "--format",
      '{{range .Mounts}}{{if eq .Destination "/zitadel/bootstrap"}}{{.Name}}{{end}}{{end}}',
      containerId,
    ],
    composeEnv(),
  );
  const bootstrapVolume = volumeOut.trim();
  if (!bootstrapVolume) throw new Error("Could not find the zitadel bootstrap volume.");

  const fileName = remotePath.split("/").at(-1);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { stdout } = await capture(
        "docker",
        ["run", "--rm", "-v", `${bootstrapVolume}:/data`, "alpine", "cat", `/data/${fileName}`],
        composeEnv(),
      );
      const value = stdout.trim();
      if (value) return value;
    } catch {}
    await delay(1000);
  }
  throw new Error(`Timed out reading ${remotePath} from zitadel.`);
}
