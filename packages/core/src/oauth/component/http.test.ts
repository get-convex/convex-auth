import { convexTest } from "convex-test";
import { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import { decryptTicketPayload } from "./crypto.ts";
import schema from "./schema.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";

const modules = import.meta.glob("./**/*.ts");

/** Fixed per component instance, so they can't come off a per-flow fixture. */
const CLIENT_ID = "test-client-id";
const PROVIDER_NAME = "test-provider";

/** Everything `createAuthorizationRequest` takes except the state hash. */
type FlowRequest = Omit<
  FunctionArgs<typeof api.provider.createAuthorizationRequest>,
  "stateHash"
>;

/**
 * The component never branches on which provider it serves, so no fixture
 * names a real one. What the callback does branch on is where a flow's
 * identity comes from, and these are the shapes that produces: an id_token,
 * userinfo responses, both, or (as {@link BASE_REQUEST} alone) neither, which
 * is a misconfiguration two tests exercise.
 *
 * These carry every field the real app-side `setupOauth` would send, so a test
 * declares its whole flow and {@link startFlow} adds no defaults of its own.
 */
const BASE_REQUEST = {
  providerName: PROVIDER_NAME,
  redirectTo: "https://app.example.com/after",
  tokenEndpoint: "https://provider.example.com/token",
} satisfies FlowRequest;

/** Identity from validated id_token claims. */
const ID_TOKEN_REQUEST = {
  ...BASE_REQUEST,
  issuers: ["https://provider.example.com"],
} satisfies FlowRequest;

/** No id_token; identity spread across two endpoints. */
const USERINFO_REQUEST = {
  ...BASE_REQUEST,
  userInfoEndpoints: {
    profile: "https://provider.example.com/profile",
    emails: "https://provider.example.com/emails",
  },
} satisfies FlowRequest;

/** Both sources at once. */
const COMBINED_REQUEST = {
  ...ID_TOKEN_REQUEST,
  ...USERINFO_REQUEST,
} satisfies FlowRequest;

function setup() {
  // One instance serving one provider: the component instance binds the
  // provider's credentials. convex-test doesn't emulate component env
  // bindings or the backend applying httpPrefix to CONVEX_SITE_URL, so the
  // component-side values are stubbed directly (CONVEX_SITE_URL with the
  // prefix already applied, as the backend would present it).
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv(
    "CONVEX_SITE_URL",
    `https://test.convex.site/oauth/${PROVIDER_NAME}`,
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
 * Route keys come off the flow fixtures rather than repeating a URL, so a
 * route can't drift from the endpoint the flow was configured with.
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

/** Valid id_token claims, overridable per test. */
function idTokenClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ID_TOKEN_REQUEST.issuers[0],
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "sub-1",
    email: "ada@example.com",
    email_verified: true,
    ...overrides,
  };
}

/**
 * Record an authorization request the way the app-side `startSignIn` would,
 * returning the raw `state` the provider echoes back to the callback plus
 * its hash (which binds redemption to the initiating client).
 */
async function startFlow(
  t: ReturnType<typeof setup>,
  request: FlowRequest,
): Promise<{ state: string; stateHash: string }> {
  const state = "state-raw-1";
  const stateHash = await sha256Hex(state);
  await t.mutation(api.provider.createAuthorizationRequest, {
    ...request,
    stateHash,
  });
  return { state, stateHash };
}

/** GET the component's callback route the way the identity provider redirect would. */
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
  redirectTo = BASE_REQUEST.redirectTo,
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
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);
    vi.advanceTimersByTime(11 * 60 * 1000);
    const response = await callback(t, { state, code: "code-1" });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("expired");
    expect(loggedText(warnSpy)).toContain("expired authorization request");
  });

  test("a provider error of access_denied passes through normalized", async () => {
    const t = setup();
    spyConsoleError();
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);
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
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);
    const response = await callback(t, {
      state,
      error: "temporarily_unavailable",
    });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
  });

  test("a callback with neither code nor error normalizes to oauth_error", async () => {
    const t = setup();
    const errors = spyConsoleError();
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);
    const response = await callback(t, { state });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("missing code");
  });

  test("an id_token flow exchanges the code and mints a redeemable ticket", async () => {
    const t = setup();
    const claims = idTokenClaims();
    const calls = stubFetch({
      [ID_TOKEN_REQUEST.tokenEndpoint]: () =>
        jsonResponse({
          id_token: unsignedJwt(claims),
          access_token: "access-token-1",
        }),
    });
    const { state, stateHash } = await startFlow(t, {
      ...ID_TOKEN_REQUEST,
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
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe(
      "https://test.convex.site/oauth/test-provider/callback",
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
      providerName: PROVIDER_NAME,
      ticketCodeHash: await sha256Hex(ticketCode),
      stateHash,
    });
    expect(claimed).not.toBeNull();
    const payload = JSON.parse(
      await decryptTicketPayload(ticketCode, claimed!.encryptedPayload),
    );
    expect(payload).toEqual({ claims });
  });

  test("a userinfo flow fetches each endpoint with the access token", async () => {
    // The asserted headers are provider-driven: http.ts documents why Accept
    // and User-Agent are sent at all (GitHub needs both).
    const t = setup();
    const { profile: profileUrl, emails: emailsUrl } =
      USERINFO_REQUEST.userInfoEndpoints;
    const profile = { id: "user-1", name: "Ada" };
    const emails = [
      { email: "ada@example.com", primary: true, verified: true },
    ];
    const calls = stubFetch({
      [USERINFO_REQUEST.tokenEndpoint]: () =>
        jsonResponse({ access_token: "access-token-1" }),
      [profileUrl]: () => jsonResponse(profile),
      [emailsUrl]: () => jsonResponse(emails),
    });
    const { state, stateHash } = await startFlow(t, USERINFO_REQUEST);

    const response = await callback(t, {
      state,
      code: "auth-code-2",
    });

    const profileCall = calls.find((c) => c.url === profileUrl);
    const headers = profileCall!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-token-1");
    expect(headers["User-Agent"]).toBe("convex-auth");

    const ticketCode = redirectParams(response).get(OAUTH_CODE_PARAM)!;
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: PROVIDER_NAME,
      ticketCodeHash: await sha256Hex(ticketCode),
      stateHash,
    });
    const payload = JSON.parse(
      await decryptTicketPayload(ticketCode, claimed!.encryptedPayload),
    );
    expect(payload).toEqual({ userInfoResponses: { profile, emails } });
  });

  test("a flow with both identity sources carries each into one payload", async () => {
    // The two sources are independent, so a provider can supply both. This is
    // the only case where both halves of the handler contribute to a payload.
    const t = setup();
    const { profile: profileUrl, emails: emailsUrl } =
      COMBINED_REQUEST.userInfoEndpoints;
    const claims = idTokenClaims();
    const profile = { id: "user-1", name: "Ada" };
    const emails = [
      { email: "ada@example.com", primary: true, verified: true },
    ];
    stubFetch({
      [COMBINED_REQUEST.tokenEndpoint]: () =>
        jsonResponse({
          id_token: unsignedJwt(claims),
          access_token: "access-token-1",
        }),
      [profileUrl]: () => jsonResponse(profile),
      [emailsUrl]: () => jsonResponse(emails),
    });
    const { state, stateHash } = await startFlow(t, COMBINED_REQUEST);

    const response = await callback(t, {
      state,
      code: "auth-code-3",
    });

    const ticketCode = redirectParams(response).get(OAUTH_CODE_PARAM)!;
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: PROVIDER_NAME,
      ticketCodeHash: await sha256Hex(ticketCode),
      stateHash,
    });
    const payload = JSON.parse(
      await decryptTicketPayload(ticketCode, claimed!.encryptedPayload),
    );
    expect(payload).toEqual({
      claims,
      userInfoResponses: { profile, emails },
    });
  });

  test("stale outcome params on redirectTo are replaced, app params kept", async () => {
    // A retry after a failed attempt: the page URL the new flow snapshots as
    // redirectTo still carries the previous attempt's outcome param.
    const t = setup();
    const redirectTo = `${BASE_REQUEST.redirectTo}?${OAUTH_ERROR_PARAM}=expired&tab=settings`;
    stubFetch({
      [ID_TOKEN_REQUEST.tokenEndpoint]: () =>
        jsonResponse({ id_token: unsignedJwt(idTokenClaims()) }),
    });
    const { state } = await startFlow(t, { ...ID_TOKEN_REQUEST, redirectTo });

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
      [ID_TOKEN_REQUEST.tokenEndpoint]: () =>
        new Response("bad request", { status: 400 }),
    });
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);

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
      [ID_TOKEN_REQUEST.tokenEndpoint]: () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.example.com/token" },
        }),
    });
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("responded with a redirect");
  });

  describe("id_token validation", () => {
    /** Run `request`'s flow against a token endpoint returning `idToken`. */
    async function callbackWithIdToken(
      t: ReturnType<typeof setup>,
      request: FlowRequest,
      idToken: string,
    ): Promise<Response> {
      stubFetch({
        [request.tokenEndpoint]: () =>
          jsonResponse({ id_token: idToken, access_token: "access-token-1" }),
      });
      const { state } = await startFlow(t, request);
      return await callback(t, { state, code: "code-1" });
    }

    test("an id_token with no configured issuer is refused", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        BASE_REQUEST,
        unsignedJwt(idTokenClaims()),
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain("no issuer is configured");
    });

    test("an id_token from any of the configured issuers is accepted", async () => {
      const t = setup();
      const request = {
        ...BASE_REQUEST,
        issuers: ["https://provider.example.com", "provider.example.com"],
      } satisfies FlowRequest;
      const response = await callbackWithIdToken(
        t,
        request,
        unsignedJwt(idTokenClaims({ iss: "provider.example.com" })),
      );
      expect(redirectParams(response).get(OAUTH_CODE_PARAM)).toEqual(
        expect.any(String),
      );
    });

    test("an issuer mismatch is refused", async () => {
      const t = setup();
      const errors = spyConsoleError();
      const response = await callbackWithIdToken(
        t,
        ID_TOKEN_REQUEST,
        unsignedJwt(idTokenClaims({ iss: "https://evil.example.com" })),
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
        ID_TOKEN_REQUEST,
        unsignedJwt(idTokenClaims({ aud: [CLIENT_ID, "other-client"] })),
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
        ID_TOKEN_REQUEST,
        unsignedJwt(idTokenClaims({ azp: "other-client" })),
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
        ID_TOKEN_REQUEST,
        unsignedJwt(idTokenClaims({ exp: Math.floor(Date.now() / 1000) - 60 })),
      );
      expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe(
        "oauth_error",
      );
      expect(loggedText(errors)).toContain("id_token is expired");
    });
  });

  test("a failed userinfo request redirects with oauth_error", async () => {
    const t = setup();
    const errors = spyConsoleError();
    const { profile: profileUrl, emails: emailsUrl } =
      USERINFO_REQUEST.userInfoEndpoints;
    stubFetch({
      [USERINFO_REQUEST.tokenEndpoint]: () =>
        jsonResponse({ access_token: "access-token-1" }),
      [profileUrl]: () => new Response("server error", { status: 500 }),
      [emailsUrl]: () => jsonResponse([]),
    });
    const { state } = await startFlow(t, USERINFO_REQUEST);

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain('Userinfo request "profile" failed');
  });

  test("userinfo endpoints without an access_token are refused", async () => {
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [USERINFO_REQUEST.tokenEndpoint]: () => jsonResponse({}),
    });
    const { state } = await startFlow(t, USERINFO_REQUEST);

    const response = await callback(t, { state, code: "code-1" });

    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain(
      "Token exchange returned no access_token",
    );
  });

  test("a response with nothing to identify the user is refused", async () => {
    // BASE_REQUEST configures neither identity source, and the exchange
    // returns no id_token, so there is nothing to build an account from.
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [BASE_REQUEST.tokenEndpoint]: () =>
        jsonResponse({ access_token: "access-token-1" }),
    });
    const { state } = await startFlow(t, BASE_REQUEST);

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
      [ID_TOKEN_REQUEST.tokenEndpoint]: (init) => {
        const stalled = new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
        // The handler arms its timeout before calling fetch, so the timer is
        // live here; advancing past it fires the abort.
        vi.advanceTimersByTime(10 * 1000);
        return stalled;
      },
    });
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);

    const response = await callback(t, { state, code: "code-1" });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("aborted");
  });

  test("a token endpoint that stalls mid-body is aborted", async () => {
    // Simulates a provider that sends response headers but never sends the
    // body. The callback must read the body while its fetch timeout is still
    // armed. highWaterMark 0 keeps pull() from running until the body is
    // read, so a callback that clears the timeout before reading the body
    // hangs this test instead of passing it.
    vi.useFakeTimers();
    const t = setup();
    const errors = spyConsoleError();
    stubFetch({
      [ID_TOKEN_REQUEST.tokenEndpoint]: (init) =>
        new Response(
          new ReadableStream(
            {
              start(controller) {
                init.signal?.addEventListener("abort", () =>
                  controller.error(
                    new DOMException("The operation was aborted", "AbortError"),
                  ),
                );
              },
              pull() {
                vi.advanceTimersByTime(10 * 1000);
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    });
    const { state } = await startFlow(t, ID_TOKEN_REQUEST);

    const response = await callback(t, { state, code: "code-1" });
    expect(redirectParams(response).get(OAUTH_ERROR_PARAM)).toBe("oauth_error");
    expect(loggedText(errors)).toContain("aborted");
  });
});
