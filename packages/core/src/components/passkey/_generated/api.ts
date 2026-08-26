/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as authentication from "../authentication.js";
import type * as ceremonies from "../ceremonies.js";
import type * as cleanup from "../cleanup.js";
import type * as helpers from "../helpers.js";
import type * as management_add from "../management/add.js";
import type * as management_list from "../management/list.js";
import type * as management_react from "../management/react.js";
import type * as management_remove from "../management/remove.js";
import type * as purposes from "../purposes.js";
import type * as react from "../react.js";
import type * as registration from "../registration.js";
import type * as setup from "../setup.js";
import type * as testAuthenticator from "../testAuthenticator.js";
import type * as validation from "../validation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  authentication: typeof authentication;
  ceremonies: typeof ceremonies;
  cleanup: typeof cleanup;
  helpers: typeof helpers;
  "management/add": typeof management_add;
  "management/list": typeof management_list;
  "management/react": typeof management_react;
  "management/remove": typeof management_remove;
  purposes: typeof purposes;
  react: typeof react;
  registration: typeof registration;
  setup: typeof setup;
  testAuthenticator: typeof testAuthenticator;
  validation: typeof validation;
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
  batchWorker: import("@convex-dev/batch-worker/_generated/component.js").ComponentApi<"batchWorker">;
};
