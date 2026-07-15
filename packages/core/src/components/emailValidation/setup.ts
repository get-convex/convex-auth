import type { ComponentApi as ResendComponentApi } from "@convex-dev/resend/_generated/component.js";
import type { ComponentApi } from "./_generated/component";
import type {
  DataModelWithVerifiableEmail,
  EmailValidationOptions,
} from "./config";

/**
 * This is the **only** email-validation source that imports
 * `@convex-dev/resend` types, so only apps that actually mount email validation
 * (and therefore depend on resend) ever typecheck against them.
 */

// What an app passes to `emailValidation()`: the mounted email-validation and
// resend components plus the sender address and optional resend settings.
type EmailValidationSetupOptions = {
  /** The mounted email-validation component (`components.authEmailValidation`). */
  component: ComponentApi;
  /** The mounted resend component (`components.resend`). */
  resend: ResendComponentApi;
  /** The `From` header for validation emails, e.g. `"My App <auth@x.com>"`. */
  from: string;
  /** Resend API key; defaults to `process.env.RESEND_API_KEY` at call time. */
  apiKey?: string;
  /** Resend test mode; defaults to `true` (matching resend's own default). */
  testMode?: boolean;
};

/**
 * Configure email validation for the `"email"`-mode password provider.
 *
 * The `<DataModel>` type argument is **mandatory** and is checked at
 * compile time against two requirements, surfaced as human-readable error
 * strings in place of the options type when unmet:
 *
 *  1. The type argument must be supplied (otherwise `DataModel` is `never`).
 *  2. The app's `users` table must declare `email` as `v.optional(v.string())`.
 *     A required `email: v.string()` is assignable to the `email?: string`
 *     constraint, so it is caught here by the `undefined extends …["email"]`
 *     conditional rather than by the constraint alone — closing a gap that would
 *     otherwise let a schema through that breaks at runtime (the users row is
 *     created without an email at sign-up). (`{} extends Pick<…>` doesn't work
 *     through the generic parameter: the constraint's `GenericDataModel` index
 *     signature makes the picked property look required.)
 *
 * Usage:
 * ```ts
 * emailValidation<DataModel>({
 *   component: components.authEmailValidation,
 *   resend: components.resend,
 *   from: "My App <auth@example.com>",
 * })
 * ```
 */
export function emailValidation<
  DataModel extends DataModelWithVerifiableEmail = never,
>(
  options: [DataModel] extends [never]
    ? "Pass your app's DataModel as the type argument: emailValidation<DataModel>({ ... })"
    : undefined extends DataModel["users"]["document"]["email"]
      ? EmailValidationSetupOptions
      : "users.email must be declared as v.optional(v.string()) to use email validation",
): EmailValidationOptions {
  // The conditional arg type guarantees `options` is the real object at every
  // valid call site; re-narrow past the error-string branches for the body.
  const opts = options as unknown as EmailValidationSetupOptions;
  return {
    component: opts.component,
    sendEmailRef: opts.resend.lib.sendEmail,
    from: opts.from,
    apiKey: opts.apiKey,
    testMode: opts.testMode,
  };
}
