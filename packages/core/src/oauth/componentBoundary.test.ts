/**
 * Tests that each OAuth provider's `startSignIn` and `completeSignIn` reach
 * their component through the `component` option the app passes in.
 *
 * Most OAuth tests use `asComponentApi` and run the component as the test's
 * root. A test there passes even if the code ignores the `component` option
 * and calls the component's own generated `api`. That code breaks in a real
 * app, where those references point at the app's own modules. These tests
 * run as an app with the components installed, so that mistake fails here.
 *
 * TODO(erquhart) Remove this file when every provider has `startSignIn` and
 * `completeSignIn` tests that run from an app root.
 *
 * @module
 */
import { convexTest } from "convex-test";
import { componentsGeneric, makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerAppleOauth } from "../components/testing/apple.ts";
import { registerGithubOauth } from "../components/testing/github.ts";
import { registerGoogleOauth } from "../components/testing/google.ts";
import { registerOauth } from "../components/testing/oauth.ts";
import type { ComponentApi as AppleComponentApi } from "./apple/_generated/component.ts";
import { setupApple } from "./apple/index.ts";
import type { ComponentApi as OauthComponentApi } from "./component/_generated/component.ts";
import { setupOauth } from "./component/setup.ts";
import type { ComponentApi as GithubComponentApi } from "./github/_generated/component.ts";
import { setupGithub } from "./github/index.ts";
import type { ComponentApi as GoogleComponentApi } from "./google/_generated/component.ts";
import { setupGoogle } from "./google/index.ts";
import {
  ALLOWED_ORIGINS,
  fakeCallbacks,
  fakeCore,
} from "./shared/componentContract.test.ts";
import { CALLBACK_PATH } from "./shared/constants.ts";

const CLIENT_ID = "test-client-id";
const SITE_URL = "https://test.convex.site/oauth/test-provider";
const CALLBACK_URL = `${SITE_URL}${CALLBACK_PATH}`;
const REDIRECT_TO = `${ALLOWED_ORIGINS[0]}/after`;

const components = componentsGeneric() as unknown as {
  oauth: OauthComponentApi<"oauth">;
  oauthApple: AppleComponentApi<"oauthApple">;
  oauthGithub: GithubComponentApi<"oauthGithub">;
  oauthGoogle: GoogleComponentApi<"oauthGoogle">;
};

const acme = setupOauth(
  fakeCore,
  "acme",
  {
    authorizationEndpoint: "https://provider.example/authorize",
    tokenEndpoint: "https://provider.example/token",
    scopes: [],
    profile: () => ({ id: "account-1" }),
  },
  fakeCallbacks,
  { component: components.oauth, allowedRedirectOrigins: ALLOWED_ORIGINS },
);

const testApp = {
  startSignInAcme: acme.startSignIn,
  completeSignInAcme: acme.completeSignIn,
  ...setupApple(fakeCore, {
    component: components.oauthApple,
    allowedRedirectOrigins: ALLOWED_ORIGINS,
  }).attachUserCallbacks(fakeCallbacks),
  ...setupGithub(fakeCore, {
    component: components.oauthGithub,
    allowedRedirectOrigins: ALLOWED_ORIGINS,
  }).attachUserCallbacks(fakeCallbacks),
  ...setupGoogle(fakeCore, {
    component: components.oauthGoogle,
    allowedRedirectOrigins: ALLOWED_ORIGINS,
  }).attachUserCallbacks(fakeCallbacks),
};

/**
 * The app's modules. convex-test takes the root directory from the first path
 * that contains `_generated`, so the `_generated/api.ts` entry only has to
 * exist.
 */
const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

/**
 * An app with all four components registered. The components read the
 * credentials their instance binds and the site URL from `process.env`, so
 * both are stubbed the way the backend would present them.
 */
function setup() {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL);
  const t = convexTest(undefined, modules);
  registerOauth(t);
  registerAppleOauth(t);
  registerGithubOauth(t);
  registerGoogleOauth(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  { component: "oauth", provider: "Acme" },
  { component: "oauthApple", provider: "Apple" },
  { component: "oauthGithub", provider: "Github" },
  { component: "oauthGoogle", provider: "Google" },
])("the $component component", ({ provider }) => {
  const startSignIn = makeFunctionReference<
    "mutation",
    { redirectTo: string },
    { redirect: string; state: string }
  >(`testApp:startSignIn${provider}`);
  const completeSignIn = makeFunctionReference<
    "mutation",
    { code: string; state: string },
    unknown
  >(`testApp:completeSignIn${provider}`);

  test("startSignIn builds the redirect from what the component returns", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignIn, {
      redirectTo: REDIRECT_TO,
    });
    const params = new URL(redirect).searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(CALLBACK_URL);
  });

  test("completeSignIn looks up the ticket in the component", async () => {
    const t = setup();
    // No ticket was minted, so the component finds nothing to claim.
    expect(
      await t.mutation(completeSignIn, { code: "code-1", state: "state-1" }),
    ).toEqual({ status: "error", userError: { error: "INVALID_CODE" } });
  });
});
