/**
 * The authorization URL Google's `startSignIn` builds, run against Google's
 * own component.
 *
 * @module
 */
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupGoogle } from "../../methods/google/server.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCallbacks,
  fakeCore,
  testAuthorizationUrl,
} from "../../lib/oauth/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithGoogle } = setupGoogle(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

testAuthorizationUrl(schema, modules, startSignInWithGoogle, {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  scope: "openid email profile",
});

/**
 * Sign-up that also asks for calendar access with a refresh token, and keeps
 * the tokens: the configuration this preset's options exist for.
 */
const calendar = setupGoogle(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  optionalScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  authorizationParams: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  },
}).attachUserCallbacks({
  createUser: makeFunctionReference("testApp:createUser"),
  onProviderTokens: makeFunctionReference("testApp:saveTokens"),
} as never);

const startSignInCalendar = makeFunctionReference<
  "mutation",
  { redirectTo: string; scopes?: string[]; loginHint?: string },
  { redirect: string; state: string }
>("testApp:startSignInWithGoogle");

describe("Google with calendar access", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setup() {
    vi.stubEnv("CLIENT_ID", "test-client-id");
    vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/google");
    return convexTest(schema, {
      ...modules,
      "./testApp.ts": async () => ({
        startSignInWithGoogle: calendar.startSignInWithGoogle,
      }),
    });
  }

  test("asks for offline calendar access on top of the sign-in scopes", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignInCalendar, {
      redirectTo: `${ALLOWED_ORIGINS[0]}/after`,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      loginHint: "ada@example.com",
    });

    const params = new URL(redirect).searchParams;
    expect(params.get("scope")).toBe(
      "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
    );
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("include_granted_scopes")).toBe("true");
    expect(params.get("login_hint")).toBe("ada@example.com");

    const request = await t.run(
      async (ctx) => await ctx.db.query("authorizationRequests").unique(),
    );
    expect(request?.includeProviderTokens).toBe(true);
  });

  test("refuses a scope the setup didn't allow", async () => {
    const t = setup();
    await expect(
      t.mutation(startSignInCalendar, {
        redirectTo: `${ALLOWED_ORIGINS[0]}/after`,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }),
    ).rejects.toThrow(/is not in this provider's optionalScopes/);
  });
});
