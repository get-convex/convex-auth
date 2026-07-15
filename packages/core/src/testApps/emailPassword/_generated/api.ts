/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as users from "../users.js";
import type * as resendSpy from "../resendSpy.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";
import type { ComponentApi as Core } from "../../../components/core/_generated/component.js";
import type { ComponentApi as PasswordProvider } from "../../../components/password/_generated/component.js";
import type { ComponentApi as EmailValidation } from "../../../components/emailValidation/_generated/component.js";

const fullApi: ApiFromModules<{
  auth: typeof auth;
  users: typeof users;
  resendSpy: typeof resendSpy;
}> = anyApi as any;

export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  core: Core<"core">;
  authPasswordProvider: PasswordProvider<"authPasswordProvider">;
  authEmailValidation: EmailValidation<"authEmailValidation">;
};
