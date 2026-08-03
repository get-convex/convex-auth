import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { ComponentApi } from "./_generated/component.js";
import schema from "./schema.js";
import { setupOauth, type OauthProfile } from "./setup";
import { encryptTicketPayload, generateRandomToken } from "./crypto";
import { sha256Hex } from "../../lib/crypto";
import type { AuthClaims, ProviderHelpers, TokenBundle } from "../../lib/types";

/**
 * Tests for the app-side `completeSignIn` mutation that `setupOauth`
 * produces, run against the real component (real `claimTicket`, real ticket
 * crypto). The seam into the core — `helpers.completeSignIn`, which turns
 * verified claims into a session — is faked and spied here; the real one is
 * covered by the core's own suite (components/core/core.test.ts).
 */

/**
 * Test-only spy state for the fake helpers, mirroring the core suite's
 * testApp pattern: the suite runs in one process, so module-level state read
 * and reset directly is a stable spy.
 */
const completeSignInCalls: AuthClaims[] = [];

/**
 * When set, the fake `helpers.completeSignIn` throws this instead of
 * returning a bundle — modeling the app rejecting the sign-in from its
 * `createOrUpdateUser` callback.
 */
const helperFailure = { error: undefined as Error | undefined };

/** The bundle the fake helpers mint on success. */
const FAKE_BUNDLE: TokenBundle = {
  accessToken: "access-token-1",
  accessTokenExpiresAt: 253402300800000,
  refreshToken: "refresh-token-1",
  refreshTokenExpiresAt: 253402300800000,
  userId: "user-1",
};

/**
 * Fake {@link ProviderHelpers}: `completeSignIn` records the claims it was
 * handed and returns {@link FAKE_BUNDLE} (or throws per
 * {@link helperFailure}). `resolveUserId` is never reached by redemption.
 */
const fakeHelpers: ProviderHelpers = {
  completeSignIn: async (_ctx, claims) => {
    completeSignInCalls.push({ ...claims });
    if (helperFailure.error !== undefined) {
      throw helperFailure.error;
    }
    return FAKE_BUNDLE;
  },
  resolveUserId: async () => null,
};

/**
 * Provider options for every instance under test. The component's own
 * generated `api` stands in for the app-side mount reference
 * (`components.oauthAcme`): the harness root IS the component, so its
 * self-references resolve exactly like a mount's would. The cast bridges the
 * generated api's "public" visibility to the mount type's "internal".
 */
const OPTIONS = {
  component: api as unknown as ComponentApi,
  allowedRedirectOrigins: ["https://app.example.com"],
};

/** An OIDC-style catalog whose profile maps id_token claims (like Google). */
const CLAIMS_CATALOG = {
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  issuer: "https://provider.example",
  scopes: ["openid"],
  pkce: false,
  profile: ((claims) => ({
    id: claims!.sub,
    email: claims?.email,
    name: claims?.name,
  })) satisfies OauthProfile,
};

/**
 * A plain-OAuth catalog whose profile reads typed userinfo responses (like
 * GitHub), exercising the `UserInfo` generic end to end.
 */
const USERINFO_CATALOG = {
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  userInfoEndpoints: { user: "https://provider.example/user" },
  scopes: [],
  pkce: false,
  profile: ((_claims, userInfoResponses) => ({
    id: String(userInfoResponses!.user.id),
    login: userInfoResponses!.user.login,
  })) satisfies OauthProfile<{ user: { id: number; login: string } }>,
};

/** A catalog whose profile mapping returns an empty id. */
const EMPTY_ID_CATALOG = {
  ...CLAIMS_CATALOG,
  profile: (() => ({ id: "" })) satisfies OauthProfile,
};

/**
 * A catalog whose profile mapping omits the id entirely — modeling an untyped
 * (plain JS) mapping, which the cast stands in for since `OauthProfile`'s
 * return type makes this unwritable directly.
 */
const MISSING_ID_CATALOG = {
  ...CLAIMS_CATALOG,
  profile: (() => ({})) as unknown as OauthProfile,
};

/**
 * The app-side functions under test, named statically the way a catalog
 * module names them. They aren't component modules (in a real deployment
 * they live in the app), so they can't come from the module glob; instead
 * they're injected below as a synthetic `testApp` module, which convex-test
 * invokes like any registered function (argument and return validation,
 * transactions, and all). A real testApp.ts in this directory would leak
 * public mutations into the component's generated API.
 */
const testApp = {
  completeSignInAcme: setupOauth("acme", CLAIMS_CATALOG, fakeHelpers, OPTIONS)
    .completeSignIn,
  completeSignInAcmeInfo: setupOauth(
    "acmeInfo",
    USERINFO_CATALOG,
    fakeHelpers,
    OPTIONS,
  ).completeSignIn,
  completeSignInEmptyId: setupOauth(
    "emptyId",
    EMPTY_ID_CATALOG,
    fakeHelpers,
    OPTIONS,
  ).completeSignIn,
  completeSignInMissingId: setupOauth(
    "missingId",
    MISSING_ID_CATALOG,
    fakeHelpers,
    OPTIONS,
  ).completeSignIn,
};

const modules = {
  ...import.meta.glob("./**/*.ts"),
  "./testApp.ts": async () => testApp,
};

const completeSignInAcme = makeFunctionReference<"mutation">(
  "testApp:completeSignInAcme",
);
const completeSignInAcmeInfo = makeFunctionReference<"mutation">(
  "testApp:completeSignInAcmeInfo",
);
const completeSignInEmptyId = makeFunctionReference<"mutation">(
  "testApp:completeSignInEmptyId",
);
const completeSignInMissingId = makeFunctionReference<"mutation">(
  "testApp:completeSignInMissingId",
);

function setup() {
  return convexTest(schema, modules);
}

/** Valid id_token claims for the acme provider's payloads. */
const CLAIMS = {
  sub: "acme-sub-1",
  email: "ada@example.com",
  name: "Ada",
};

/**
 * Mint a ticket the way the callback leg does after a successful exchange:
 * real ticket code, hashes, and payload encryption. Returns the raw code,
 * which is what the client presents at redemption.
 */
async function mintTicket(
  t: ReturnType<typeof setup>,
  args: {
    providerName?: string;
    state?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  const ticketCode = generateRandomToken();
  await t.mutation(internal.provider.createTicket, {
    providerName: args.providerName ?? "acme",
    stateHash: await sha256Hex(args.state ?? "state-1"),
    ticketCodeHash: await sha256Hex(ticketCode),
    payload: await encryptTicketPayload(
      ticketCode,
      JSON.stringify(args.payload ?? { claims: CLAIMS }),
    ),
  });
  return ticketCode;
}

afterEach(() => {
  vi.useRealTimers();
  completeSignInCalls.length = 0;
  helperFailure.error = undefined;
});

describe("completeSignIn", () => {
  test("redeems a minted ticket into a session bundle via the profile mapping", async () => {
    const t = setup();
    const code = await mintTicket(t);

    const bundle = await t.mutation(completeSignInAcme, {
      code,
      state: "state-1",
    });

    expect(bundle).toEqual(FAKE_BUNDLE);
    // The decrypted payload flowed through the catalog's profile mapping
    // into the core seam.
    expect(completeSignInCalls).toEqual([
      {
        provider: "acme",
        providerAccountId: "acme-sub-1",
        profile: { id: "acme-sub-1", email: "ada@example.com", name: "Ada" },
      },
    ]);
  });

  test("passes userinfo responses to the profile mapping", async () => {
    const t = setup();
    const code = await mintTicket(t, {
      providerName: "acmeInfo",
      payload: { userInfoResponses: { user: { id: 42, login: "octocat" } } },
    });

    const bundle = await t.mutation(completeSignInAcmeInfo, {
      code,
      state: "state-1",
    });

    expect(bundle).toEqual(FAKE_BUNDLE);
    expect(completeSignInCalls).toEqual([
      {
        provider: "acmeInfo",
        providerAccountId: "42",
        profile: { id: "42", login: "octocat" },
      },
    ]);
  });

  test("an unknown code returns null", async () => {
    const t = setup();
    const result = await t.mutation(completeSignInAcme, {
      code: "never-minted",
      state: "state-1",
    });
    expect(result).toBeNull();
    expect(completeSignInCalls).toHaveLength(0);
  });

  test("a wrong state returns null and preserves the ticket", async () => {
    const t = setup();
    const code = await mintTicket(t);

    const mismatched = await t.mutation(completeSignInAcme, {
      code,
      state: "someone-elses-state",
    });
    expect(mismatched).toBeNull();

    // The ticket survives a mismatched attempt; the initiating client can
    // still complete.
    const bundle = await t.mutation(completeSignInAcme, {
      code,
      state: "state-1",
    });
    expect(bundle).toEqual(FAKE_BUNDLE);
  });

  test("a code redeems exactly once", async () => {
    const t = setup();
    const code = await mintTicket(t);

    const first = await t.mutation(completeSignInAcme, {
      code,
      state: "state-1",
    });
    expect(first).toEqual(FAKE_BUNDLE);

    const second = await t.mutation(completeSignInAcme, {
      code,
      state: "state-1",
    });
    expect(second).toBeNull();
    expect(completeSignInCalls).toHaveLength(1);
  });

  test("an expired ticket returns null", async () => {
    vi.useFakeTimers();
    const t = setup();
    const code = await mintTicket(t);
    vi.advanceTimersByTime(3 * 60 * 1000); // past the 2-minute ticket TTL

    const result = await t.mutation(completeSignInAcme, {
      code,
      state: "state-1",
    });
    expect(result).toBeNull();
    expect(completeSignInCalls).toHaveLength(0);
  });

  test("a profile mapping that returns an empty id throws", async () => {
    const t = setup();
    const code = await mintTicket(t, { providerName: "emptyId" });

    await expect(
      t.mutation(completeSignInEmptyId, { code, state: "state-1" }),
    ).rejects.toThrow(/returned no id/);
  });

  test("a profile mapping that omits the id throws", async () => {
    const t = setup();
    const code = await mintTicket(t, { providerName: "missingId" });

    await expect(
      t.mutation(completeSignInMissingId, { code, state: "state-1" }),
    ).rejects.toThrow(/returned no id/);
  });

  test("an app rejection rolls back the ticket claim", async () => {
    const t = setup();
    const code = await mintTicket(t);

    // The app rejects the sign-in (thrown from createOrUpdateUser, surfaced
    // through the core seam)...
    helperFailure.error = new Error("sign-ups are closed");
    await expect(
      t.mutation(completeSignInAcme, { code, state: "state-1" }),
    ).rejects.toThrow("sign-ups are closed");

    // ...and the claim rolled back with the rest of the mutation, so the
    // ticket is not burned by the failed attempt.
    helperFailure.error = undefined;
    const bundle = await t.mutation(completeSignInAcme, {
      code,
      state: "state-1",
    });
    expect(bundle).toEqual(FAKE_BUNDLE);
  });
});
