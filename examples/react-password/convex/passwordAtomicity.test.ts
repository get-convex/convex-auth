import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api, components } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasswordProvider } from "@convex-dev/auth/providers/testing/password";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

// Sign-up must be atomic: if one step fails, no earlier step may commit.
// To prove it, this file injects failures into two steps of the flow:
//  - `failCreateOrUpdateUser` makes the app's user callback throw. This
//    fails the flow early, before any write happens.
//  - `failSetPassword` makes the password component report a failure. This
//    fails the flow late, after the core `signIn` step already wrote the
//    user, account, and session rows.
const state = vi.hoisted(() => ({
  failCreateOrUpdateUser: false,
  failSetPassword: false,
}));

vi.mock("./users.js", async () => {
  const { internalMutation } = await import("./_generated/server.js");
  const { v } = await import("convex/values");
  return {
    createOrUpdateUser: internalMutation({
      args: {
        provider: v.literal("password"),
        providerAccountId: v.string(),
        profile: v.any(),
        userId: v.union(v.string(), v.null()),
      },
      returns: v.id("users"),
      handler: async (ctx, args) => {
        if (state.failCreateOrUpdateUser) {
          throw new Error("Simulated createOrUpdateUser failure");
        }
        // The same behavior as the real `createOrUpdateUser` in `users.ts`.
        if (args.userId !== null) {
          const existing = ctx.db.normalizeId("users", args.userId);
          if (existing === null) {
            throw new Error(`Unknown user id: ${args.userId}`);
          }
          return existing;
        }
        const username =
          typeof args.profile?.username === "string"
            ? args.profile.username
            : undefined;
        return await ctx.db.insert("users", { username });
      },
    }),
  };
});

// Replace the password component's `setPassword`. The replacement can fail on
// demand. Its success path only reports success and stores nothing: the real
// Argon2id hashing is not needed to test atomicity, and the example app does
// not depend on `argon2id-wasm` directly.
vi.mock(
  "../../../packages/core/src/components/password/public.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../packages/core/src/components/password/public.js")
      >();
    const { mutation } =
      await import("../../../packages/core/src/components/password/_generated/server.js");
    const { v } = await import("convex/values");
    return {
      ...actual,
      setPassword: mutation({
        args: { userId: v.string(), password: v.string() },
        handler: async (_ctx, _args) => {
          if (state.failSetPassword) {
            return {
              success: false as const,
              userError: {
                error: "PASSWORD_TOO_SHORT" as const,
                minimumLength: 10,
              },
            };
          }
          return { success: true as const };
        },
      }),
    };
  },
);

async function setup() {
  // The core signs JWTs from these env vars (see core/public.ts). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(pkcs8));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
  state.failCreateOrUpdateUser = false;
  state.failSetPassword = false;
});

// Assert that the failed sign-up left no trace behind.
async function expectNoTrace(t: Awaited<ReturnType<typeof setup>>) {
  // No app user was created...
  const users = await t.run((ctx) => ctx.db.query("users").collect());
  expect(users).toEqual([]);

  // ...and no account row survived in the core component, so the username
  // is not taken.
  const accountUserId = await t.run((ctx) =>
    ctx.runQuery(components.core.public.getUserIdByAccount, {
      provider: "password",
      providerAccountId: "alice",
    }),
  );
  expect(accountUserId).toBe(null);
}

// The username stayed free: a later sign-up succeeds.
async function expectRetryToSucceed(t: Awaited<ReturnType<typeof setup>>) {
  const retry = await t.mutation(api.auth.signUpWithPassword, {
    username: "alice",
    password: PASSWORD,
  });
  expect(retry).toMatchObject({ success: true });
}

describe("sign-up atomicity", () => {
  test("a failure before any write leaves no trace", async () => {
    const t = await setup();

    state.failCreateOrUpdateUser = true;
    await expect(
      t.mutation(api.auth.signUpWithPassword, {
        username: "alice",
        password: PASSWORD,
      }),
    ).rejects.toThrow("Simulated createOrUpdateUser failure");

    await expectNoTrace(t);
    state.failCreateOrUpdateUser = false;
    await expectRetryToSucceed(t);
  });

  test("a failure in the last step rolls back every earlier write", async () => {
    const t = await setup();

    // `setPassword` is the last step of sign-up. When it fails, the user,
    // account, and session rows are already written. The provider must throw
    // so that the transaction rolls all of them back.
    state.failSetPassword = true;
    await expect(
      t.mutation(api.auth.signUpWithPassword, {
        username: "alice",
        password: PASSWORD,
      }),
    ).rejects.toThrow("Unexpected error when setting the password");

    await expectNoTrace(t);
    state.failSetPassword = false;
    await expectRetryToSucceed(t);
  });
});
