/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as challenge_addEmail from "../challenge/addEmail.js";
import type * as challenge_common from "../challenge/common.js";
import type * as challenge_custom from "../challenge/custom.js";
import type * as challenge_rateLimit from "../challenge/rateLimit.js";
import type * as challenge_setPrimaryEmail from "../challenge/setPrimaryEmail.js";
import type * as helpers from "../helpers.js";
import type * as react from "../react.js";
import type * as setup from "../setup.js";
import type * as testSetup from "../testSetup.js";
import type * as validation from "../validation.js";
import type * as verifiedEmails from "../verifiedEmails.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  "challenge/addEmail": typeof challenge_addEmail;
  "challenge/common": typeof challenge_common;
  "challenge/custom": typeof challenge_custom;
  "challenge/rateLimit": typeof challenge_rateLimit;
  "challenge/setPrimaryEmail": typeof challenge_setPrimaryEmail;
  helpers: typeof helpers;
  react: typeof react;
  setup: typeof setup;
  testSetup: typeof testSetup;
  validation: typeof validation;
  verifiedEmails: typeof verifiedEmails;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
