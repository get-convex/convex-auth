#!/usr/bin/env node
/**
 * Generates an RS256 key pair and sets the AUTH_PRIVATE_KEY and AUTH_JWKS
 * environment variables in the Convex deployment for the current directory.
 *
 * Idempotent: if both keys are already set on the deployment it leaves them
 * untouched, so re-running (or running after they were set elsewhere) won't
 * rotate the signing key out from under existing sessions. Pass `--force` to
 * generate and overwrite a fresh pair regardless.
 *
 * Usage:
 *   npx generate-auth-keys [--force]
 */
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";

const ALG = "RS256";
const force = process.argv.includes("--force");

/** Returns the env var's value if it's set on the deployment, else null. */
function getEnv(key) {
  const result = spawnSync("npx", ["convex", "env", "get", key], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

function setEnv(key, value) {
  const result = spawnSync("npx", ["convex", "env", "set", key, value], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!force && getEnv("AUTH_PRIVATE_KEY") && getEnv("AUTH_JWKS")) {
  console.log(
    "AUTH_PRIVATE_KEY and AUTH_JWKS are already set; leaving them unchanged. " +
      "Pass --force to generate a new key pair.",
  );
  process.exit(0);
}

const { publicKey, privateKey } = await generateKeyPair(ALG, {
  extractable: true,
});
const privatePem = await exportPKCS8(privateKey);
const pubJwk = await exportJWK(publicKey);
const kid = randomUUID();

const authPrivateKey = Buffer.from(privatePem).toString("base64");
const authJwks = JSON.stringify({
  keys: [{ ...pubJwk, kid, alg: ALG, use: "sig" }],
});

setEnv("AUTH_PRIVATE_KEY", authPrivateKey);
setEnv("AUTH_JWKS", authJwks);
