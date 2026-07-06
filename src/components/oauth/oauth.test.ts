import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { hashToken } from "../../lib/crypto.js";
import type { ProviderName } from "../../lib/oauth.js";

const modules = import.meta.glob("./**/*.ts");

// The app frontend origin the callback redirects back into.
const SITE_URL = "http://localhost:5173";

// The client-held verifier binding a flow to the browser that started it; its
// hash travels to `/start` as the `challenge` and the verifier itself is
// presented again at redemption.
const VERIFIER = "test-flow-verifier";
const challenge = () => hashToken(VERIFIER);

/**
 * Configure this instance's bound env vars the way a real mount would. Inside
 * an http-prefixed component, Convex rewrites CONVEX_SITE_URL to include the
 * mount's prefix — the tests reproduce that rewritten form, since it's what
 * the redirect-URI derivation builds on.
 */
function setup(provider: ProviderName) {
  process.env.PROVIDER = provider;
  process.env.OAUTH_CLIENT_ID = "client-id";
  process.env.OAUTH_CLIENT_SECRET = "client-secret";
  process.env.SITE_URL = SITE_URL;
  process.env.CONVEX_SITE_URL = `https://tame-plover-123.convex.site/auth/${provider}`;
  delete process.env.OAUTH_REDIRECT_URI;
  return convexTest(schema, modules);
}

function expectedRedirectUri(provider: ProviderName): string {
  return `https://tame-plover-123.convex.site/auth/${provider}/callback`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stub global fetch with per-URL handlers (query strings ignored). Arctic
 * invokes `fetch(request)` with a `Request`; the component's own profile
 * fetches use `fetch(url, init)` — both shapes are normalized here.
 */
function stubFetch(
  handlers: Record<string, (request: Request) => Response | Promise<Response>>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = request.url.split("?")[0];
      const handler = handlers[url];
      if (!handler) throw new Error(`Unexpected fetch in test: ${request.url}`);
      return await handler(request);
    }),
  );
}

/** An unsigned JWT whose payload decodes like a Google ID token. */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const googleProfilePayload = {
  sub: "google-user-1",
  email: "alice@example.com",
  email_verified: true,
  name: "Alice",
  picture: "https://example.com/alice.png",
  given_name: "Alice",
  family_name: "Liddell",
};

/** Stub Google's token endpoint with a happy-path exchange. */
function stubGoogleExchange(): { tokenRequestBody: () => string } {
  let body = "";
  stubFetch({
    "https://oauth2.googleapis.com/token": async (request) => {
      body = await request.text();
      return jsonResponse({
        access_token: "google-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: fakeIdToken(googleProfilePayload),
        scope: "openid profile email",
      });
    },
  });
  return { tokenRequestBody: () => body };
}

/** Start a flow via the HTTP route and capture what the browser would carry. */
async function startFlow(
  t: ReturnType<typeof setup>,
  opts: { redirectTo?: string } = { redirectTo: "/dash" },
) {
  const params = new URLSearchParams({ challenge: await challenge() });
  if (opts.redirectTo !== undefined) {
    params.set("redirectTo", opts.redirectTo);
  }
  const response = await t.fetch(`/start?${params.toString()}`);
  expect(response.status).toBe(302);
  const authorizationUrl = new URL(response.headers.get("Location")!);
  const state = authorizationUrl.searchParams.get("state")!;
  return { authorizationUrl, state };
}

describe("GET /start", () => {
  test("google: redirects to the provider with PKCE and stores the flow", async () => {
    const t = setup("google");
    const { authorizationUrl, state } = await startFlow(t);

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      expectedRedirectUri("google"),
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "openid profile email",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(state.startsWith("google:")).toBe(true);

    const row = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").unique(),
    );
    expect(row).toMatchObject({
      state,
      intent: "session",
      redirectTo: "/dash",
      challenge: await challenge(),
    });
    // The PKCE verifier never appears in the authorization URL.
    expect(row!.codeVerifier).toBeTruthy();
    expect(authorizationUrl.toString()).not.toContain(row!.codeVerifier!);
    expect(row!.expiresAt).toBeGreaterThan(Date.now());
  });

  test("github: redirects to the provider without PKCE", async () => {
    const t = setup("github");
    const { authorizationUrl, state } = await startFlow(t);

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      expectedRedirectUri("github"),
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "read:user user:email",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeNull();
    expect(state.startsWith("github:")).toBe(true);

    const row = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").unique(),
    );
    expect(row!.codeVerifier).toBeUndefined();
  });

  test("defaults redirectTo to /", async () => {
    const t = setup("google");
    await startFlow(t, {});
    const row = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").unique(),
    );
    expect(row!.redirectTo).toBe("/");
  });

  test("honors an explicit OAUTH_REDIRECT_URI override", async () => {
    const t = setup("google");
    process.env.OAUTH_REDIRECT_URI = "https://auth.example.com/cb";
    const { authorizationUrl } = await startFlow(t);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://auth.example.com/cb",
    );
  });

  test.each([
    ["a protocol-relative URL", "//evil.com"],
    ["an absolute URL", "https%3A%2F%2Fevil.com"],
    ["a backslash path", "/%5Cevil.com"],
    // URL parsing strips ASCII tab/newline, so these would resolve
    // protocol-relative to evil.com if judged as strings alone.
    ["a tab-split protocol-relative URL", "/%09/evil.com"],
    ["a newline-split protocol-relative URL", "/%0A/evil.com"],
  ])("rejects %s redirectTo", async (_label, redirectTo) => {
    const t = setup("google");
    const response = await t.fetch(
      `/start?redirectTo=${redirectTo}&challenge=${await challenge()}`,
    );
    expect(response.status).toBe(400);
    const states = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").collect(),
    );
    expect(states).toHaveLength(0);
  });

  test.each([
    ["a missing", ""],
    ["a malformed", "&challenge=not-a-sha256-hash"],
  ])("rejects %s challenge", async (_label, challengeQuery) => {
    const t = setup("google");
    const response = await t.fetch(`/start?redirectTo=/dash${challengeQuery}`);
    expect(response.status).toBe(400);
    const states = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").collect(),
    );
    expect(states).toHaveLength(0);
  });

  test.each([["authenticate"], ["junk"]])(
    "rejects intent=%s (only session flows are supported)",
    async (intent) => {
      const t = setup("google");
      const response = await t.fetch(
        `/start?intent=${intent}&challenge=${await challenge()}`,
      );
      expect(response.status).toBe(400);
    },
  );
});

describe("GET /callback", () => {
  test("google: exchanges the code and hands the app a redeemable one-time code", async () => {
    const t = setup("google");
    const { state } = await startFlow(t);
    const stateRow = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").unique(),
    );
    const exchange = stubGoogleExchange();

    const response = await t.fetch(
      `/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(302);
    // The Location carries the one-time code; nothing may cache it.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const target = new URL(response.headers.get("Location")!);
    expect(target.origin).toBe(SITE_URL);
    expect(target.pathname).toBe("/dash");
    const code = target.searchParams.get("code")!;
    expect(code.startsWith("google:")).toBe(true);

    // The exchange presented the stored PKCE verifier and the provider code.
    expect(exchange.tokenRequestBody()).toContain("code=provider-code");
    expect(exchange.tokenRequestBody()).toContain(
      `code_verifier=${stateRow!.codeVerifier}`,
    );

    // Claims are parked hashed — the raw code is nowhere in storage — and the
    // flow's challenge carried over from the state row.
    const pending = await t.run(
      async (ctx) => await ctx.db.query("pendingSignIns").unique(),
    );
    expect(pending!.codeHash).not.toBe(code);
    expect(pending!.challenge).toBe(await challenge());

    const redeemed = await t.mutation(api.public.redeem, {
      code,
      verifier: VERIFIER,
    });
    expect(redeemed).toEqual({
      intent: "session",
      claims: {
        provider: "google",
        providerAccountId: "google-user-1",
        profile: {
          email: "alice@example.com",
          emailVerified: true,
          name: "Alice",
          picture: "https://example.com/alice.png",
          givenName: "Alice",
          familyName: "Liddell",
        },
      },
    });

    // Single use: a second redemption returns null.
    expect(
      await t.mutation(api.public.redeem, { code, verifier: VERIFIER }),
    ).toBeNull();
  });

  test("github: fetches the profile and verified email", async () => {
    const t = setup("github");
    const { state } = await startFlow(t);
    stubFetch({
      "https://github.com/login/oauth/access_token": () =>
        jsonResponse({ access_token: "gh-access-token", token_type: "bearer" }),
      "https://api.github.com/user": () =>
        jsonResponse({
          id: 42,
          login: "octo",
          name: null,
          avatar_url: "https://example.com/octo.png",
          email: null,
        }),
      "https://api.github.com/user/emails": () =>
        jsonResponse([
          { email: "old@example.com", primary: false, verified: true },
          { email: "octo@example.com", primary: true, verified: true },
        ]),
    });

    const response = await t.fetch(
      `/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("Location")!).searchParams.get(
      "code",
    )!;

    const redeemed = await t.mutation(api.public.redeem, {
      code,
      verifier: VERIFIER,
    });
    expect(redeemed).toEqual({
      intent: "session",
      claims: {
        provider: "github",
        providerAccountId: "42",
        profile: {
          email: "octo@example.com",
          emailVerified: true,
          name: "octo",
          picture: "https://example.com/octo.png",
          username: "octo",
        },
      },
    });
  });

  test("redirects with access_denied when the provider reports an error", async () => {
    const t = setup("google");
    const { state } = await startFlow(t);

    const response = await t.fetch(
      `/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    // The state row was consumed, so the browser still lands on the flow's
    // redirectTo.
    expect(target.pathname).toBe("/dash");
    expect(target.searchParams.get("error")).toBe("access_denied");

    const states = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").collect(),
    );
    expect(states).toHaveLength(0);
  });

  test("redirects with invalid_state for an unknown state", async () => {
    const t = setup("google");
    const response = await t.fetch(
      "/callback?code=provider-code&state=google%3Aunknown",
    );
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(target.origin).toBe(SITE_URL);
    expect(target.pathname).toBe("/");
    expect(target.searchParams.get("error")).toBe("invalid_state");
  });

  test("redirects with invalid_state for an expired state", async () => {
    const t = setup("google");
    const { state } = await startFlow(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthStates").unique();
      await ctx.db.patch("oauthStates", row!._id, {
        expiresAt: Date.now() - 1000,
      });
    });

    const response = await t.fetch(
      `/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );
    expect(
      new URL(response.headers.get("Location")!).searchParams.get("error"),
    ).toBe("invalid_state");
  });

  test("redirects with invalid_state when code or state is missing", async () => {
    const t = setup("google");
    const response = await t.fetch("/callback");
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("Location")!).searchParams.get("error"),
    ).toBe("invalid_state");
  });

  test("a state is single-use even when the exchange fails", async () => {
    const t = setup("google");
    const { state } = await startFlow(t);
    stubFetch({
      "https://oauth2.googleapis.com/token": () =>
        new Response("nope", { status: 400 }),
    });

    const failed = await t.fetch(
      `/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );
    const failedTarget = new URL(failed.headers.get("Location")!);
    // The exchange failed after state consumption, so the flow still knows
    // where to land.
    expect(failedTarget.pathname).toBe("/dash");
    expect(failedTarget.searchParams.get("error")).toBe("exchange_failed");

    // Replaying the same state is now invalid.
    const replayed = await t.fetch(
      `/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    );
    expect(
      new URL(replayed.headers.get("Location")!).searchParams.get("error"),
    ).toBe("invalid_state");
  });

});

/** Run a full flow through the HTTP routes and return the one-time code. */
async function completeFlowForCode(
  t: ReturnType<typeof setup>,
): Promise<string> {
  const { state } = await startFlow(t);
  stubGoogleExchange();
  const response = await t.fetch(
    `/callback?code=provider-code&state=${encodeURIComponent(state)}`,
  );
  return new URL(response.headers.get("Location")!).searchParams.get("code")!;
}

describe("redeem", () => {
  test("returns null for an unknown code", async () => {
    const t = setup("google");
    expect(
      await t.mutation(api.public.redeem, {
        code: "google:unknown",
        verifier: VERIFIER,
      }),
    ).toBeNull();
  });

  test("returns null for an expired code", async () => {
    const t = setup("google");
    const code = await completeFlowForCode(t);

    await t.run(async (ctx) => {
      const row = await ctx.db.query("pendingSignIns").unique();
      await ctx.db.patch("pendingSignIns", row!._id, {
        expiresAt: Date.now() - 1000,
      });
    });
    expect(
      await t.mutation(api.public.redeem, { code, verifier: VERIFIER }),
    ).toBeNull();
  });

  test("a wrong verifier returns null and burns the code", async () => {
    const t = setup("google");
    const code = await completeFlowForCode(t);

    expect(
      await t.mutation(api.public.redeem, { code, verifier: "not-it" }),
    ).toBeNull();
    // The failed attempt consumed the code: the right verifier is too late,
    // so a stolen code can't be brute-forced against.
    expect(
      await t.mutation(api.public.redeem, { code, verifier: VERIFIER }),
    ).toBeNull();
    const pending = await t.run(
      async (ctx) => await ctx.db.query("pendingSignIns").collect(),
    );
    expect(pending).toHaveLength(0);
  });
});

describe("expired-row cleanup", () => {
  test("starting a flow sweeps out expired states", async () => {
    const t = setup("google");
    // Abandoned flows: rows past their TTL that no callback will ever consume.
    await t.run(async (ctx) => {
      for (const n of [1, 2, 3]) {
        await ctx.db.insert("oauthStates", {
          state: `google:stale-${n}`,
          challenge: "stale-challenge",
          intent: "session",
          redirectTo: "/",
          expiresAt: Date.now() - 1000,
        });
      }
    });

    const { state } = await startFlow(t);
    const rows = await t.run(
      async (ctx) => await ctx.db.query("oauthStates").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(state);
  });

  test("minting a one-time code sweeps out expired pending sign-ins", async () => {
    const t = setup("google");
    await t.run(async (ctx) => {
      await ctx.db.insert("pendingSignIns", {
        codeHash: "stale-hash",
        challenge: "stale-challenge",
        claims: { provider: "google", providerAccountId: "x", profile: {} },
        intent: "session",
        expiresAt: Date.now() - 1000,
      });
    });

    await completeFlowForCode(t);
    const rows = await t.run(
      async (ctx) => await ctx.db.query("pendingSignIns").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toBe("stale-hash");
  });
});
