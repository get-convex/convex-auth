/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as auth from "../auth.js";
import type * as auth_core from "../auth/core.js";
import type * as auth_group from "../auth/group.js";
import type * as bench from "../bench.js";
import type * as comments from "../comments.js";
import type * as errors from "../errors.js";
import type * as functions from "../functions.js";
import type * as groups from "../groups.js";
import type * as http from "../http.js";
import type * as issues from "../issues.js";
import type * as issues_http from "../issues/http.js";
import type * as oauth from "../oauth.js";
import type * as projects from "../projects.js";
import type * as roles from "../roles.js";
import type * as staticHosting from "../staticHosting.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  auth: typeof auth;
  "auth/core": typeof auth_core;
  "auth/group": typeof auth_group;
  bench: typeof bench;
  comments: typeof comments;
  errors: typeof errors;
  functions: typeof functions;
  groups: typeof groups;
  http: typeof http;
  issues: typeof issues;
  "issues/http": typeof issues_http;
  oauth: typeof oauth;
  projects: typeof projects;
  roles: typeof roles;
  staticHosting: typeof staticHosting;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  auth: import("@robelest/convex-auth/_generated/component.js").ComponentApi<"auth">;
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
