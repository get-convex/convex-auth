import { password } from "@robelest/convex-auth/providers/password";
import { credentialsSignInImpl } from "@robelest/convex-auth/server/mutations/credentials/signin";
import * as mutations from "@robelest/convex-auth/server/mutations/calls";
import { enrichActionCtx } from "@robelest/convex-auth/server/runtime";
import { signInImpl } from "@robelest/convex-auth/server/signin/flow";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { afterEach, expect, test, vi } from "vite-plus/test";

afterEach(() => {
  vi.restoreAllMocks();
});

function createCredentialsMutationHarness(args: {
  emailVerified?: string;
  hasTotp?: boolean;
  rateLimit?: {
    _id: string;
    identifier: string;
    attemptsLeft: number;
    lastAttemptTime: number;
  } | null;
  totpDoc?: { _id: string } | null;
  accountMissing?: boolean;
}) {
  const refs = {
    accountGet: Symbol("accountGet"),
    userGetById: Symbol("userGetById"),
    userPatch: Symbol("userPatch"),
    sessionCreate: Symbol("sessionCreate"),
    signInCheck: Symbol("signInCheck"),
    signInRecord: Symbol("signInRecord"),
    signInReset: Symbol("signInReset"),
    totpGetVerifiedByUserId: Symbol("totpGetVerifiedByUserId"),
  } as const;

  const account = {
    _id: "account1",
    _creationTime: Date.now(),
    userId: "user1",
    provider: "password",
    providerAccountId: "user@example.com",
    secret: "stored-hash",
    emailVerified: args.emailVerified,
  };

  let user = {
    _id: "user1",
    _creationTime: Date.now(),
    email: "user@example.com",
    hasTotp: args.hasTotp,
  };

  const runQuery = vi.fn(async (ref: unknown) => {
    if (ref === refs.accountGet) {
      return args.accountMissing ? null : account;
    }
    if (ref === refs.userGetById) {
      return user;
    }
    if (ref === refs.signInCheck) {
      return { ok: args.rateLimit ? args.rateLimit.attemptsLeft >= 1 : true };
    }
    if (ref === refs.totpGetVerifiedByUserId) {
      return args.totpDoc ?? null;
    }
    throw new Error(`Unexpected query ref: ${String(ref)}`);
  });

  const runMutation = vi.fn(async (ref: unknown, mutationArgs: unknown) => {
    if (ref === refs.userPatch) {
      const patch = mutationArgs as { data: { hasTotp: boolean } };
      user = { ...user, ...patch.data };
      return null;
    }
    if (ref === refs.signInReset) {
      return null;
    }
    if (ref === refs.sessionCreate) {
      return {
        userId: "user1",
        sessionId: "session1",
        refreshTokenId: "refresh1",
      };
    }
    if (ref === refs.signInRecord) {
      return { ok: true };
    }
    throw new Error(`Unexpected mutation ref: ${String(ref)}`);
  });

  const ctx = {
    runQuery,
    runMutation,
    auth: { getUserIdentity: async () => null },
  } as any;

  const config = {
    component: {
      user: {
        get: refs.userGetById,
        update: refs.userPatch,
      },
      account: { get: refs.accountGet },
      session: { create: refs.sessionCreate },
      limits: {
        signInCheck: refs.signInCheck,
        signInRecord: refs.signInRecord,
        signInReset: refs.signInReset,
      },
      factor: {
        totp: { get: refs.totpGetVerifiedByUserId },
      },
    },
  } as any;

  return { account, config, ctx, refs, runMutation, runQuery, user: () => user };
}

test("credentialsSignIn skips session issuance when email verification is required", async () => {
  const harness = createCredentialsMutationHarness({
    emailVerified: undefined,
    hasTotp: undefined,
    rateLimit: {
      _id: "rate-limit1",
      identifier: "account1",
      attemptsLeft: 9,
      lastAttemptTime: Date.now(),
    },
  });

  const result = await credentialsSignInImpl(
    harness.ctx,
    {
      provider: "password",
      account: { id: "user@example.com", secret: "secret" },
      generateTokens: true,
      requireVerifiedEmail: true,
      enforceTotp: true,
    },
    () =>
      ({
        id: "password",
        type: "credentials",
        crypto: {
          verifySecret: vi.fn(async () => true),
        },
      }) as any,
    harness.config,
  );

  expect(result).toEqual({
    kind: "emailVerificationRequired",
    account: { _id: "account1", emailVerified: undefined },
    user: { _id: "user1", email: "user@example.com" },
  });
  expect(harness.runMutation).toHaveBeenCalledWith(harness.refs.signInReset, {
    identifier: "account1",
  });
  expect(harness.runMutation).not.toHaveBeenCalledWith(
    harness.refs.sessionCreate,
    expect.anything(),
  );
  expect(harness.runQuery).not.toHaveBeenCalledWith(
    harness.refs.totpGetVerifiedByUserId,
    expect.anything(),
  );
});

test("credentialsSignIn resolves TOTP enrollment by query without caching", async () => {
  const harness = createCredentialsMutationHarness({
    emailVerified: "verified",
    hasTotp: undefined,
    rateLimit: null,
    totpDoc: null,
  });

  const result = await credentialsSignInImpl(
    harness.ctx,
    {
      provider: "password",
      account: { id: "user@example.com", secret: "secret" },
      generateTokens: true,
      requireVerifiedEmail: false,
      enforceTotp: true,
    },
    () =>
      ({
        id: "password",
        type: "credentials",
        crypto: {
          verifySecret: vi.fn(async () => true),
        },
      }) as any,
    harness.config,
  );

  expect(result.kind).toBe("signedIn");
  if (result.kind !== "signedIn") {
    throw new Error("Expected sign-in result");
  }
  expect(result.user.hasTotp).toBe(false);
  expect(harness.runQuery).toHaveBeenCalledWith(
    harness.refs.totpGetVerifiedByUserId,
    expect.anything(),
  );
  expect(harness.runMutation).not.toHaveBeenCalledWith(harness.refs.userPatch, expect.anything());
  expect(harness.runMutation).toHaveBeenCalledWith(
    harness.refs.sessionCreate,
    expect.objectContaining({ userId: "user1" }),
  );
});

test("password provider routes unverified sign-in through verify provider without issuing a session", async () => {
  const verifyProvider = { id: "verify-email", type: "email" } as any;
  const verifyResult = { userId: "user1", sessionId: "session1" };
  const callCredentialsSignIn = vi.spyOn(mutations, "callCredentialsSignIn").mockResolvedValue({
    kind: "emailVerificationRequired",
    account: { _id: "account1" },
    user: { _id: "user1", email: "user@example.com" },
  } as any);

  const provider = password({ verify: verifyProvider });
  const ctx = {
    auth: {
      provider: {
        signIn: vi.fn(async () => verifyResult),
      },
    },
  } as any;
  const params = {
    email: "user@example.com",
    password: "supersecret",
    flow: "signIn",
  };

  expect(await provider.authorize(params, ctx)).toEqual(verifyResult);
  expect(callCredentialsSignIn).toHaveBeenCalledWith(
    ctx,
    expect.objectContaining({
      requireVerifiedEmail: true,
      provider: "password",
    }),
  );
  expect(ctx.auth.provider.signIn).toHaveBeenCalledWith(ctx, verifyProvider, {
    accountId: "account1",
    params,
  });
});

test("runtime enrichment preserves non-enumerable Convex action methods", async () => {
  type FakeActionCtx = {
    auth: { getUserIdentity(): Promise<null> };
    runAction(ref: string): Promise<string>;
    runMutation(ref: string): Promise<string>;
    runQuery(ref: string): Promise<string>;
    secretDescriptor: string;
  };

  const originalThisValues: unknown[] = [];
  const authCtx = {
    getUserIdentity: async function (this: unknown) {
      expect(this).toBe(authCtx);
      return null;
    },
  };
  const originalCtx = { auth: authCtx } as FakeActionCtx;

  Object.defineProperties(originalCtx, {
    runAction: {
      value: async function (this: unknown, ref: string) {
        originalThisValues.push(this);
        return `action:${ref}`;
      },
    },
    runMutation: {
      value: async function (this: unknown, ref: string) {
        originalThisValues.push(this);
        return `mutation:${ref}`;
      },
    },
    runQuery: {
      value: async function (this: unknown, ref: string) {
        originalThisValues.push(this);
        return `query:${ref}`;
      },
    },
    secretDescriptor: {
      value: "preserved",
    },
  });

  expect(({ ...originalCtx } as Partial<FakeActionCtx>).runQuery).toBeUndefined();

  const enriched = enrichActionCtx(originalCtx as unknown as GenericActionCtx<GenericDataModel>, {
    getUserIdentity: authCtx.getUserIdentity.bind(authCtx),
    config: { component: {} },
  }) as unknown as FakeActionCtx & {
    auth: typeof authCtx & { config: { component: Record<string, never> } };
  };

  expect(enriched.secretDescriptor).toBe("preserved");
  expect(await enriched.runQuery("get")).toBe("query:get");
  expect(await enriched.runMutation("set")).toBe("mutation:set");
  expect(await enriched.runAction("do")).toBe("action:do");
  expect(await enriched.auth.getUserIdentity()).toBeNull();
  expect(originalThisValues).toEqual([originalCtx, originalCtx, originalCtx]);
});

test("credentials sign-in keeps the no-token contract when authorize pre-issues a session", async () => {
  const provider = {
    id: "custom",
    type: "credentials",
    authorize: vi.fn(async () => ({
      userId: "user1",
      hasTotp: false,
      issuance: {
        userId: "user1",
        sessionId: "session1",
        refreshToken: "refresh1|session1",
      },
    })),
  } as any;

  const result = await signInImpl(
    {
      auth: { config: {} },
      runQuery: vi.fn(),
      runMutation: vi.fn(),
    } as any,
    provider,
    { params: {} },
    { generateTokens: false, allowExtraProviders: false },
  );

  expect(result).toEqual({
    kind: "signedIn",
    session: {
      userId: "user1",
      sessionId: "session1",
      tokens: null,
    },
  });
});

test("credentialsSignIn verifies against a dummy hash when the account is missing (enumeration timing)", async () => {
  const harness = createCredentialsMutationHarness({ accountMissing: true });
  const verifySecret = vi.fn(async (_secret: string, _hash: string) => false);

  const result = await credentialsSignInImpl(
    harness.ctx,
    {
      provider: "password",
      account: { id: "ghost@example.com", secret: "attempt-secret" },
      generateTokens: true,
      requireVerifiedEmail: false,
      enforceTotp: false,
    },
    () =>
      ({
        id: "password",
        type: "credentials",
        crypto: { verifySecret },
      }) as any,
    harness.config,
  );

  expect(result).toEqual({ kind: "invalidAccount" });
  // The fix: even though no account exists, the submitted secret must still be
  // run through verify (against a constant dummy hash), so a missing account is
  // not distinguishable from a wrong password by response timing.
  expect(verifySecret).toHaveBeenCalledTimes(1);
  // Verified against the constant throwaway dummy scrypt hash, never a real one.
  expect(verifySecret).toHaveBeenCalledWith("attempt-secret", expect.stringContaining("scrypt:"));
  // The missing-account branch must never issue a session.
  expect(harness.runMutation).not.toHaveBeenCalledWith(
    harness.refs.sessionCreate,
    expect.anything(),
  );
});
