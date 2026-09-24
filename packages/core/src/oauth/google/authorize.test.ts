/**
 * The authorization URL Google's `startSignIn` builds, run against Google's
 * own component.
 *
 * @module
 */
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupGoogle } from "./index.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCallbacks,
  fakeCore,
  testAuthorizationUrl,
} from "../shared/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInGoogle } = setupGoogle(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

testAuthorizationUrl(schema, modules, startSignInGoogle, {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  scope: "openid email profile",
});
