/// <reference types="vite-plus/client" />

import resendTest from "@convex-dev/resend/test";
import staticHostingTest from "@convex-dev/static-hosting/test";
import authTest from "@robelest/convex-auth/test";
import { convexTest as baseConvexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

/**
 * A typed handle for the auth component's `maintenance.pruneExpired`, which is an internal
 * (cron-driven) component mutation deliberately kept off the public `ComponentApi` so a mounting
 * app cannot invoke the bulk delete. `convex-test` still resolves it at runtime via the registered
 * module map, so white-box tests use this handle to trigger it.
 */
export const pruneExpiredForTest = (
  auth: unknown,
): FunctionReference<"mutation", "internal", { batchSize: number }, Record<string, number>> =>
  (
    auth as {
      maintenance: {
        pruneExpired: FunctionReference<
          "mutation",
          "internal",
          { batchSize: number },
          Record<string, number>
        >;
      };
    }
  ).maintenance.pruneExpired;

if (!process.env.APP_URL) {
  process.env.APP_URL = "http://localhost:5173";
}

if (!process.env.CONVEX_SITE_URL) {
  process.env.CONVEX_SITE_URL = "http://127.0.0.1:3211";
}

if (!process.env.AUTH_EMAIL) {
  process.env.AUTH_EMAIL = "test@example.com";
}

if (!process.env.RESEND_API_KEY) {
  process.env.RESEND_API_KEY = "test-resend-api-key";
}

if (!process.env.AUTH_GOOGLE_ID) {
  process.env.AUTH_GOOGLE_ID = "test-google-client-id";
}

if (!process.env.AUTH_GOOGLE_SECRET) {
  process.env.AUTH_GOOGLE_SECRET = "test-google-client-secret";
}

if (!process.env.AUTH_SECRET_ENCRYPTION_KEY) {
  process.env.AUTH_SECRET_ENCRYPTION_KEY = "test-auth-secret-encryption-key";
}

if (!process.env.JWT_PRIVATE_KEY || !process.env.JWKS) {
  const keys = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
  const publicKey = await exportJWK(keys.publicKey);
  process.env.JWKS = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
}

export * from "convex-test";

export const convexTest = ((
  schema: Parameters<typeof baseConvexTest>[0],
  modules = import.meta.glob("../../convex/**/*.*s"),
) => {
  const t = baseConvexTest(schema as never, modules as never);
  authTest.register(t as any, "auth");
  resendTest.register(t as any, "resend");
  staticHostingTest.register(t as any, "staticHosting");
  return t;
}) as typeof baseConvexTest;
