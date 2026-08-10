import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { decryptTicketPayload } from "./crypto.js";
import schema from "./schema.js";
import { sha256Hex } from "../../lib/crypto.js";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.js";

const modules = import.meta.glob("./**/*.ts");

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const DEFAULT_REDIRECT_TO = "https://app.example.com/after";

function setup(providerName = "google") {
  // One instance serving one provider: the mount binds the provider's
  // credentials. convex-test doesn't emulate mount env bindings or the
  // backend's mount-prefixed CONVEX_SITE_URL override, so the component-side
  // values are stubbed directly (CONVEX_SITE_URL with the prefix already
  // applied, as the backend would present it).
  vi.stubEnv("CLIENT_ID", "test-client-id");
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv(
    "CONVEX_SITE_URL",
    `https://test.convex.site/oauth/${providerName}`,
  );
  return convexTest(schema, modules);
}

/** One recorded outbound request made by the callback handler. */
type FetchCall = { url: string; init: RequestInit };

/**
 * Stub global `fetch` with an exact-URL routing table. `t.fetch` dispatches
 * to the component's router directly without touching global `fetch`, so the
 * stub only ever sees the handler's outbound token/userinfo requests. An
 * unrouted URL throws, failing the test loudly. The returned array records
 * every outbound request so tests can assert the exact shape of the token
 * exchange (body params, auth style).
 *
 * Intercepting outbound requests is required (the callback really calls the
 * provider's endpoints and convex-test doesn't intercept network access); we
 * stub global fetch, per convex-test's own guidance.
 */
function stubFetch(
  routes: Record<string, (init: RequestInit) => Response | Promise<Response>>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const responder = routes[url];
      if (responder === undefined) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      calls.push({ url, init: init ?? {} });
      return await responder(init ?? {});
    }),
  );
  return calls;
}

/** A 200 response carrying `body` as JSON. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Silence the handler's expected error logging and capture it, so failure
 * tests can assert the specific cause behind the normalized `oauth_error`
 * the user-visible redirect carries.
 */
function spyConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/** Like {@link spyConsoleError}, for the flow-level `console.warn` paths. */
function spyConsoleWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** Everything a spied console method logged, flattened to one string. */
function loggedText(spy: ReturnType<typeof spyConsoleError>): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A structurally valid JWT with an unverifiable signature. The callback
 * deliberately skips signature verification (the token arrives from the
 * provider's token endpoint over TLS), so this exercises every claim check.
 */
function unsignedJwt(claims: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${header}.${payload}.signature`;
}

/** Valid google-style id_token claims, overridable per test. */
function googleClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: "test-client-id",
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "google-sub-1",
    email: "ada@example.com",
    email_verified: true,
    ...overrides,
  };
}

type FlowOverrides = Partial<{
  providerName: string;
  redirectTo: string;
  codeVerifier: string;
  tokenEndpoint: string;
  userInfoEndpoints: Record<string, string>;
  issuer: string | undefined;
}>;

/**
 * Record an authorization request the way the app-side `startSignIn` would,
 * returning the raw `state` the provider echoes back to the callback plus
 * its hash (which binds redemption to the initiating client). Defaults model
 * the google catalog; override for github-style (userinfo) flows.
 */
async function startFlow(
  t: ReturnType<typeof setup>,
  overrides: FlowOverrides = {},
) {
  const state = "state-raw-1";
  const stateHash = await sha256Hex(state);
  const args = {
    providerName: "google",
    stateHash,
    redirectTo: DEFAULT_REDIRECT_TO,
    tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
    issuer: "https://accounts.google.com" as string | undefined,
    ...overrides,
  };
  await t.mutation(
    api.provider.createAuthorizationRequest,
    // An optional arg must be absent, not `undefined` (not a Convex value).
    Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    ) as typeof args,
  );
  return { state, stateHash };
}

/** GET the mount's callback route the way the identity provider redirect would. */
function callback(
  t: ReturnType<typeof setup>,
  params: Record<string, string>,
): Promise<Response> {
  return t.fetch(`/callback?${new URLSearchParams(params)}`);
}

/**
 * Assert `response` is a 302 back to `redirectTo` (ignoring query, which the
 * handler rewrites) and return the Location's params for outcome assertions.
 */
function redirectParams(
  response: Response,
  redirectTo = DEFAULT_REDIRECT_TO,
): URLSearchParams {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location")!);
  const expected = new URL(redirectTo);
  expect(`${location.origin}${location.pathname}`).toBe(
    `${expected.origin}${expected.pathname}`,
  );
  return location.searchParams;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("oauth callback", () => {
  test("a request without state gets a bare 400", async () => {
    const t = setup();
    const response = await t.fetch("/callback");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This sign-in link is invalid");
  });

  test("an unknown state gets a 400: the flow is gone entirely", async () => {
    const t = setup();
    const warnSpy = spyConsoleWarn();
    const response = await callback(t, {
      state: "never-issued",
      code: "code-1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expired or was already used");
    expect(loggedText(warnSpy)).toContain("unknown or already-used state");
  });

  test("an expired request redirects back to the app with expired", async () => {
    vi.useFakeTimers();
    const t = setup();
    const warnSpy = spyConsoleWarn();
    const { state } = await startFlow(t);
    vi.advanceTimersByTime(11 * 60 * 1000);
    const response = await callback(t, { state, code: "code-1" });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("expired");
    expect(loggedText(warnSpy)).toContain("expired authorization request");
  });

  test("a provider error of access_denied passes through normalized", async () => {
    const t = setup();
    spyConsoleError();
    const { state } = await startFlow(t);
    const response = await callback(t, {
      state,
      error: "access_denied",
    });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
      "access_denied",
    );
  });

  test("any other provider error normalizes to oauth_error", async () => {
    const t = setup();
    spyConsoleError();
    const { state } = await startFlow(t);
    const response = await callback(t, {
      state,
      error: "temporarily_unavailable",
    });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
  });

  test("a callback with neither code nor error normalizes to oauth_error", async () => {
    const t = setup();
    const errors = spyConsoleError();
    const { state } = await startFlow(t);
    const response = await callback(t, { state });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("missing code");
  });

  test("an id_token flow exchanges the code and mints a redeemable ticket", async () => {
    const t = setup();
    const claims = googleClaims();
    const calls = stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () =>
        jsonResponse({ id_token: unsignedJwt(claims), access_token: "at-1" }),
    });
    const { state, stateHash } = await startFlow(t, {
      codeVerifier: "verifier-1",
    });

    const response = await callback(t, {
      state,
      code: "auth-code-1",
    });

    // The token exchange POST carries the snapshotted exchange config.
    expect(calls).toHaveLength(1);
    const body = calls[0].init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe(
      "https://test.convex.site/oauth/google/callback",
    );
    expect(body.get("code_verifier")).toBe("verifier-1");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");

    // The redirect carries a ticket code that redeems (with the flow's
    // state) into the encrypted identity payload, the full contract the
    // app-side completeSignIn depends on. This leg only mints the ticket;
    // claiming it here directly stands in for the app-side redemption
    // covered by the redemption leg's tests.
    const ticketCode = redirectParams(response).get(OAUTH_CODE_PARAM)!;
    expect(ticketCode).toEqual(expect.any(String));
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: "google",
      ticketCodeHash: await sha256Hex(ticketCode),
      stateHash,
    });
    expect(claimed).not.toBeNull();
    const payload = JSON.parse(
      await decryptTicketPayload(ticketCode, claimed!.payload),
    );
    expect(payload).toEqual({ claims });
  });

  test("a userinfo flow fetches each endpoint with the access token", async () => {
    const t = setup("github");
    const user = { id: 42, login: "octocat" };
    const emails = [
      { email: "ada@example.com", primary: true, verified: true },
    ];
    const calls = stubFetch({
      [GITHUB_TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "gh-at-1" }),
      "https://api.github.com/user": () => jsonResponse(user),
      "https://api.github.com/user/emails": () => jsonResponse(emails),
    });
    const { state, stateHash } = await startFlow(t, {
      providerName: "github",
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
      issuer: undefined,
      userInfoEndpoints: {
        user: "https://api.github.com/user",
        emails: "https://api.github.com/user/emails",
      },
    });

    const response = await callback(t, {
      state,
      code: "auth-code-2",
    });

    const userCall = calls.find((c) => c.url === "https://api.github.com/user");
    const headers = userCall!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gh-at-1");
    expect(headers["User-Agent"]).toBe("convex-auth");

    const ticketCode = redirectParams(response).get(OAUTH_CODE_PARAM)!;
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: "github",
      ticketCodeHash: await sha256Hex(ticketCode),
      stateHash,
    });
    const payload = JSON.parse(
      await decryptTicketPayload(ticketCode, claimed!.payload),
    );
    expect(payload).toEqual({ userInfoResponses: { user, emails } });
  });

  test("stale outcome params on redirectTo are replaced, app params kept", async () => {
    // A retry after a failed attempt: the page URL the new flow snapshots as
    // redirectTo still carries the previous attempt's outcome param.
    const t = setup();
    const redirectTo = `${DEFAULT_REDIRECT_TO}?${OAUTH_ERROR_PARAM}=expired&tab=settings`;
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () =>
        jsonResponse({ id_token: unsignedJwt(googleClaims()) }),
    });
    const { state } = await startFlow(t, { redirectTo });

    const response = await callback(t, { state, code: "code-1" });

    const params = redirectParams(response, redirectTo);
    expect(params.get(OAUTH_ERROR_PARAM)).toBeNull();
    expect(params.get(OAUTH_CODE_PARAM)).toEqual(expect.any(String));
    expect(params.get("tab")).toBe("settings");
  });

  test("a failed token exchange redirects with oauth_error and mints no ticket", async () => {
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () =>
        new Response("bad request", { status: 400 }),
    });
    const { state } = await startFlow(t);

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("Token exchange failed with 400");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("tickets").collect()).toHaveLength(0);
    });
  });

  test("a token endpoint that redirects is refused", async () => {
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.com/token" },
        }),
    });
    const { state } = await startFlow(t);

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("responded with a redirect");
  });

  describe("id_token validation", () => {
    /** Run a google-style flow whose token endpoint returns `idToken`. */
    async function callbackWithIdToken(
      t: ReturnType<typeof setup>,
      idToken: string,
      overrides: FlowOverrides = {},
    ): Promise<Response> {
      stubFetch({
        [GOOGLE_TOKEN_ENDPOINT]: () =>
          jsonResponse({ id_token: idToken, access_token: "at-1" }),
      });
      const { state } = await startFlow(t, overrides);
      return await callback(t, { state, code: "code-1" });
    }

    test("an id_token with no configured issuer is refused", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        unsignedJwt(googleClaims()),
        { issuer: undefined },
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain("no issuer is configured");
    });

    test("an issuer mismatch is refused", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        unsignedJwt(googleClaims({ iss: "https://evil.example.com" })),
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain(
        "issuer does not match the configured issuer",
      );
    });

    test("a multi-audience token is refused even when it includes CLIENT_ID", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        unsignedJwt(
          googleClaims({ aud: ["test-google-client-id", "other-client"] }),
        ),
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain(
        "audience must be exactly CLIENT_ID",
      );
    });

    test("an azp for another party is refused", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        unsignedJwt(googleClaims({ azp: "other-client" })),
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain("authorized party does not match");
    });

    test("an expired id_token is refused", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        unsignedJwt(googleClaims({ exp: Math.floor(Date.now() / 1000) - 60 })),
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain("id_token is expired");
    });
  });

  test("a failed userinfo request redirects with oauth_error", async () => {
    const t = setup("github");
    const errors = spyConsoleError();
    stubFetch({
      [GITHUB_TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "gh-at-1" }),
      "https://api.github.com/user": () =>
        new Response("server error", { status: 500 }),
      "https://api.github.com/user/emails": () => jsonResponse([]),
    });
    const { state } = await startFlow(t, {
      providerName: "github",
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
      issuer: undefined,
      userInfoEndpoints: {
        user: "https://api.github.com/user",
        emails: "https://api.github.com/user/emails",
      },
    });

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain('Userinfo request "user" failed');
  });

  test("userinfo endpoints without an access_token are refused", async () => {
    const t = setup("github");
    const errors = spyConsoleError();
    stubFetch({
      [GITHUB_TOKEN_ENDPOINT]: () => jsonResponse({}),
    });
    const { state } = await startFlow(t, {
      providerName: "github",
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
      issuer: undefined,
      userInfoEndpoints: { user: "https://api.github.com/user" },
    });

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain(
      "Token exchange returned no access_token",
    );
  });

  test("a response with nothing to identify the user is refused", async () => {
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () => jsonResponse({ access_token: "at-1" }),
    });
    // No id_token comes back and no userinfo endpoints are configured.
    const { state } = await startFlow(t, { issuer: undefined });

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain(
      "no id_token and no userInfoEndpoints",
    );
  });

  test("a token endpoint that stalls past the timeout is aborted", async () => {
    vi.useFakeTimers();
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: (init) => {
        const stalled = new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
        // The handler arms its timeout before calling fetch, so the timer is
        // live here; advancing past it fires the abort.
        vi.advanceTimersByTime(30 * 1000);
        return stalled;
      },
    });
    const { state } = await startFlow(t);

    const response = await callback(t, { state, code: "code-1" });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("aborted");
  });
});
