import { authCookieNames, parseAuthCookies, server } from "@robelest/convex-auth/server";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vite-plus/test";

import {
  createOAuthAuthorizationURL,
  handleOAuthCallback,
} from "../packages/auth/src/server/oauth/runtime";
import { isLocalHost } from "../packages/auth/src/server/url";

const TEST_COOKIE_NAMESPACE = "server_security_tests";

function expectNonRedirectPreloadResult(
  result: Awaited<ReturnType<ReturnType<typeof server>["preload"]>>,
) {
  expect(result.redirect).toBe(false);
  if (result.redirect) {
    throw new Error("Expected preload() to return cookies and token");
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("isLocalHost accepts localhost hosts with or without ports", () => {
  expect(isLocalHost("localhost")).toBe(true);
  expect(isLocalHost("localhost:3000")).toBe(true);
  expect(isLocalHost("127.0.0.1")).toBe(true);
  expect(isLocalHost("127.0.0.1:8787")).toBe(true);
  expect(isLocalHost("http://localhost:5173")).toBe(true);
  expect(isLocalHost("https://127.0.0.1")).toBe(true);
  expect(isLocalHost("example.com")).toBe(false);
  expect(isLocalHost("localhost.example.com")).toBe(false);

  const localhostCookieNames = authCookieNames("localhost");
  expect(localhostCookieNames.token.startsWith("__Host-")).toBe(false);
});

test("authCookieNames isolates cookie namespaces", () => {
  const first = authCookieNames("localhost", "tenant_a");
  const second = authCookieNames("localhost", "tenant_b");

  expect(first.token).not.toBe(second.token);
  expect(first.refreshToken).not.toBe(second.refreshToken);
  expect(first.verifier).not.toBe(second.verifier);
});

test("parseAuthCookies only reads the active cookie namespace", () => {
  const host = "localhost";
  const namespace = "tenant";
  const namespaced = authCookieNames(host, namespace);
  const parsed = parseAuthCookies(
    `${namespaced.token}=namespaced-token; ${namespaced.refreshToken}=namespaced-refresh; ${namespaced.verifier}=namespaced-verifier`,
    host,
    namespace,
  );

  expect(parsed.token).toBe("namespaced-token");
  expect(parsed.refreshToken).toBe("namespaced-refresh");
  expect(parsed.verifier).toBe("namespaced-verifier");
});

test("parseAuthCookies ignores unnamespaced cookies for namespaced auth", () => {
  const host = "localhost";
  const namespace = "tenant";
  const namespaced = authCookieNames(host, namespace);
  const legacy = authCookieNames(host);
  const parsed = parseAuthCookies(
    `${legacy.token}=legacy-token; ${legacy.refreshToken}=legacy-refresh; ${legacy.verifier}=legacy-verifier; ` +
      `${namespaced.token}=namespaced-token; ${namespaced.refreshToken}=namespaced-refresh; ${namespaced.verifier}=namespaced-verifier`,
    host,
    namespace,
  );

  expect(parsed.token).toBe("namespaced-token");
  expect(parsed.refreshToken).toBe("namespaced-refresh");
  expect(parsed.verifier).toBe("namespaced-verifier");
});

test("parseAuthCookies does not fall back to old cookie names", () => {
  const host = "localhost";
  const namespace = "tenant";
  const legacy = authCookieNames(host);
  const parsed = parseAuthCookies(
    `${legacy.token}=legacy-token; ${legacy.refreshToken}=legacy-refresh; ${legacy.verifier}=legacy-verifier`,
    host,
    namespace,
  );

  expect(parsed.token).toBeNull();
  expect(parsed.refreshToken).toBeNull();
  expect(parsed.verifier).toBeNull();
});

test("OAuth callback rejects PKCE provider when verifier cookie is missing", async () => {
  const provider = {
    pkce: "required" as const,
    createAuthorizationURL(_args: {
      state: string;
      codeVerifier?: string;
      scopes: string[];
      nonce?: string;
    }) {
      return new URL("https://accounts.example.com/oauth");
    },
    validateAuthorizationCode: vi.fn(),
  };

  const authResult = await createOAuthAuthorizationURL("google", {
    provider,
  });
  const stateCookie = authResult.cookies.find((cookie) => cookie.name.endsWith("OAuthstate"));
  expect(stateCookie).toBeDefined();

  await expect(
    handleOAuthCallback(
      "google",
      { provider },
      { state: stateCookie!.value, code: "oauth-code" },
      {
        [stateCookie!.name]: stateCookie!.value,
      },
    ),
  ).rejects.toSatisfy((error: unknown) => {
    return error instanceof ConvexError && error.data?.code === "OAUTH_MISSING_VERIFIER";
  });

  expect(provider.validateAuthorizationCode).not.toHaveBeenCalled();
});

test("refresh keeps existing session when code exchange fails transiently", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(ConvexHttpClient.prototype, "action").mockRejectedValue(new Error("exchange failed"));

  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const request = new Request("https://app.example.com/?code=abc", {
    method: "GET",
    headers: {
      host,
      accept: "text/html",
      cookie: `${cookieNames.token}=jwt-token; ${cookieNames.refreshToken}=refresh-token; ${cookieNames.verifier}=verifier-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));

  expect(result.token).toBe("jwt-token");
  expect(result.cookies).toEqual([]);
});

test("refresh recovers from malformed access token with valid refresh token", async () => {
  vi.spyOn(ConvexHttpClient.prototype, "action").mockResolvedValue({
    kind: "signedIn",
    session: {
      token: "new-jwt-token",
      refreshToken: "new-refresh-token",
    },
  });

  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=not-a-jwt; ${cookieNames.refreshToken}=refresh-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));

  expect(result.token).toBe("new-jwt-token");
  expect(result.cookies.find((cookie) => cookie.name === cookieNames.token)?.value).toBe(
    "new-jwt-token",
  );
  expect(result.cookies.find((cookie) => cookie.name === cookieNames.refreshToken)?.value).toBe(
    "new-refresh-token",
  );
});

test("refresh does not mutate cookies for CORS requests", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      origin: "https://evil.example.com",
      cookie: `${cookieNames.token}=jwt-token; ${cookieNames.refreshToken}=refresh-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));
  expect(result.cookies).toEqual([]);
  expect(result.token).toBeNull();
});

test("refresh honors forwarded protocol when checking same-origin", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = unsignedToken({
    iss: "https://example.convex.cloud",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("http://127.0.0.1/internal/dashboard", {
    method: "GET",
    headers: {
      host,
      origin: "https://app.example.com",
      "x-forwarded-proto": "https",
      cookie: `${cookieNames.token}=${token}; ${cookieNames.refreshToken}=refresh-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));
  expect(result.cookies).toEqual([]);
  expect(result.token).toBe(token);
});

test("verify accepts convex.site issuer for convex.cloud URL", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const siteToken = unsignedToken({
    iss: "https://example.convex.site",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${siteToken}`,
    },
  });

  await expect(auth.verify(request)).resolves.toBe(true);
});

test("verify accepts prefixed auth issuer for convex.cloud URL", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const siteToken = unsignedToken({
    iss: "https://example.convex.site/auth",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${siteToken}`,
    },
  });

  await expect(auth.verify(request)).resolves.toBe(true);
});

test("refresh keeps prefixed auth issuer cookies", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const siteToken = unsignedToken({
    iss: "https://example.convex.site/auth",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${siteToken}; ${cookieNames.refreshToken}=refresh-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));
  expect(result.cookies).toEqual([]);
  expect(result.token).toBe(siteToken);
});

test("verify accepts convex.cloud issuer for convex.cloud URL", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cloudToken = unsignedToken({
    iss: "https://example.convex.cloud",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${cloudToken}`,
    },
  });

  await expect(auth.verify(request)).resolves.toBe(true);
});

test("verify supports acceptedIssuers override", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    acceptedIssuers: ["https://issuer.internal.example"],
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const customToken = unsignedToken({
    iss: "https://issuer.internal.example",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });
  const defaultToken = unsignedToken({
    iss: "https://example.convex.cloud",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const customRequest = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${customToken}`,
    },
  });
  const defaultRequest = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${defaultToken}`,
    },
  });

  await expect(auth.verify(customRequest)).resolves.toBe(true);
  await expect(auth.verify(defaultRequest)).resolves.toBe(false);
});

test("verify rejects unrelated issuer tokens", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const foreignToken = unsignedToken({
    iss: "https://malicious.example.com",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${foreignToken}`,
    },
  });

  await expect(auth.verify(request)).resolves.toBe(false);
});

test("refresh keeps valid convex.site issuer token for convex.cloud URL", async () => {
  const actionSpy = vi.spyOn(ConvexHttpClient.prototype, "action").mockResolvedValue({
    kind: "signedIn",
    session: {
      token: "unexpected-token",
      refreshToken: "unexpected-refresh-token",
    },
  });

  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const siteToken = unsignedToken({
    iss: "https://example.convex.site",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${siteToken}; ${cookieNames.refreshToken}=refresh-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));
  expect(result.cookies).toEqual([]);
  expect(result.token).toBe(siteToken);
  expect(actionSpy).not.toHaveBeenCalled();
});

test("refresh clears foreign issuer token before expiry checks", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const foreignToken = unsignedToken({
    iss: "https://other-deployment.convex.cloud",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${foreignToken}; ${cookieNames.refreshToken}=foreign-refresh-token`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));
  expect(result.token).toBeNull();
  expect(result.cookies.find((cookie) => cookie.name === cookieNames.token)?.value).toBe("");
  expect(result.cookies.find((cookie) => cookie.name === cookieNames.refreshToken)?.value).toBe("");
});

test("refresh clears malformed refresh token values", async () => {
  const auth = server({
    url: "https://example.convex.cloud",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = unsignedToken({
    iss: "https://example.convex.cloud",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/dashboard", {
    method: "GET",
    headers: {
      host,
      cookie: `${cookieNames.token}=${token}; ${cookieNames.refreshToken}=dummy`,
    },
  });

  const result = expectNonRedirectPreloadResult(await auth.preload(request));
  expect(result.token).toBeNull();
  expect(result.cookies.find((cookie) => cookie.name === cookieNames.token)?.value).toBe("");
  expect(result.cookies.find((cookie) => cookie.name === cookieNames.refreshToken)?.value).toBe("");
});

test("proxy refresh keeps valid access token when refresh cookie is missing", async () => {
  const actionSpy = vi.spyOn(ConvexHttpClient.prototype, "action");
  const auth = server({
    url: "https://example.convex.cloud",
    apiRoute: "/api/auth",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = unsignedToken({
    iss: "https://example.convex.cloud",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      cookie: `${cookieNames.token}=${token}`,
    },
    body: JSON.stringify({
      action: "auth:signIn",
      args: { refreshToken: true },
    }),
  });

  const response = await auth.proxy(request);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    tokens: {
      token,
      refreshToken: "dummy",
    },
  });
  expect(result.kind ?? "signedIn").toBe("signedIn");
  expect(actionSpy).not.toHaveBeenCalled();
});

test("proxy refresh returns null when missing refresh cookie and access token is invalid", async () => {
  const actionSpy = vi.spyOn(ConvexHttpClient.prototype, "action");
  const auth = server({
    url: "https://example.convex.cloud",
    apiRoute: "/api/auth",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = unsignedToken({
    iss: "https://malicious.example.com",
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
  });

  const request = new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      cookie: `${cookieNames.token}=${token}`,
    },
    body: JSON.stringify({
      action: "auth:signIn",
      args: { refreshToken: true },
    }),
  });

  const response = await auth.proxy(request);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ tokens: null });
  expect(result.kind ?? "signedIn").toBe("signedIn");
  expect(actionSpy).not.toHaveBeenCalled();
});

test("proxy signIn errors keep existing cookies for non-refresh requests", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(ConvexHttpClient.prototype, "action").mockRejectedValue(new Error("signIn failed"));

  const auth = server({
    url: "https://example.convex.cloud",
    apiRoute: "/api/auth",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const request = new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      cookie: `${cookieNames.token}=jwt-token; ${cookieNames.refreshToken}=refresh-token; ${cookieNames.verifier}=verifier-token`,
    },
    body: JSON.stringify({
      action: "auth:signIn",
      args: {
        provider: "password",
        params: { email: "sarah@gmail.com", password: "wrong", flow: "signIn" },
      },
    }),
  });

  const response = await auth.proxy(request);
  expect(response.status).toBe(400);

  const setCookie =
    typeof (response.headers as any).getSetCookie === "function"
      ? ((response.headers as any).getSetCookie() as string[]).join("\n")
      : (response.headers.get("set-cookie") ?? "");

  expect(setCookie).toContain(`${cookieNames.token}=jwt-token`);
  expect(setCookie).toContain(`${cookieNames.refreshToken}=refresh-token`);
  expect(setCookie).toContain(`${cookieNames.verifier}=`);
});

test("proxy signIn hydrates auth from refresh cookie for device verification", async () => {
  const actionSpy = vi
    .spyOn(ConvexHttpClient.prototype, "action")
    .mockImplementation(async function (this: ConvexHttpClient, ...[_reference, args]: any[]) {
      if (typeof args === "object" && args !== null && "refreshToken" in args) {
        return {
          kind: "signedIn",
          session: {
            token: "fresh-jwt-token",
            refreshToken: "fresh-refresh-token",
          },
        };
      }

      expect((this as unknown as { auth?: string }).auth).toBe("fresh-jwt-token");
      expect(args).toMatchObject({
        provider: "device",
        params: { flow: "verify", userCode: "ABCD-EFGH" },
      });
      return { kind: "signedIn", session: null };
    });

  const auth = server({
    url: "https://example.convex.cloud",
    apiRoute: "/api/auth",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredToken = unsignedToken({
    iss: "https://example.convex.cloud",
    iat: nowSeconds - 60 * 60,
    exp: nowSeconds - 60,
  });

  const request = new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      cookie: `${cookieNames.token}=${expiredToken}; ${cookieNames.refreshToken}=refresh-token`,
    },
    body: JSON.stringify({
      action: "auth:signIn",
      args: {
        provider: "device",
        params: { flow: "verify", userCode: "ABCD-EFGH" },
      },
    }),
  });

  const response = await auth.proxy(request);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ kind: "signedIn", session: null });
  expect(actionSpy).toHaveBeenCalledTimes(2);

  const setCookie =
    typeof (response.headers as any).getSetCookie === "function"
      ? ((response.headers as any).getSetCookie() as string[]).join("\n")
      : (response.headers.get("set-cookie") ?? "");

  expect(setCookie).toContain(`${cookieNames.token}=fresh-jwt-token`);
  expect(setCookie).toContain(`${cookieNames.refreshToken}=fresh-refresh-token`);
});

test("proxy signOut retries revocation via refresh token", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let signOutCalls = 0;
  vi.spyOn(ConvexHttpClient.prototype, "action").mockImplementation(
    async (...[_reference, args]: any[]) => {
      if (typeof args === "object" && args !== null && "refreshToken" in args) {
        return {
          kind: "signedIn",
          session: {
            token: "fresh-jwt-token",
            refreshToken: "fresh-refresh-token",
          },
        };
      }
      signOutCalls += 1;
      if (signOutCalls === 1) {
        throw new Error("signOut with expired JWT failed");
      }
      return null;
    },
  );

  const auth = server({
    url: "https://example.convex.cloud",
    apiRoute: "/api/auth",
    cookieNamespace: TEST_COOKIE_NAMESPACE,
  });
  const host = "app.example.com";
  const cookieNames = authCookieNames(host, TEST_COOKIE_NAMESPACE);
  const request = new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: {
      host,
      "content-type": "application/json",
      cookie: `${cookieNames.token}=expired-jwt; ${cookieNames.refreshToken}=valid-refresh-token`,
    },
    body: JSON.stringify({
      action: "auth:signOut",
      args: {},
    }),
  });

  const response = await auth.proxy(request);
  expect(response.status).toBe(200);
  expect(signOutCalls).toBe(2);
});

function unsignedToken(payload: Record<string, unknown>) {
  const encode = (value: object) => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}
