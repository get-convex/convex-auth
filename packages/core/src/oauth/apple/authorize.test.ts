/**
 * The authorization URL Apple's `startSignIn` builds, run against Apple's own
 * component.
 *
 * @module
 */
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupApple } from "./index.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCallbacks,
  fakeCore,
  testAuthorizationUrl,
} from "../shared/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInApple } = setupApple(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

testAuthorizationUrl(schema, modules, startSignInApple, {
  authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
  scope: "name email",
  responseMode: "form_post",
});
