import { GenericDataModel } from "convex/server";
import type { ComponentApi } from "./_generated/component";

/**
 * Config types shared between the email-validation setup helper and the password
 * provider that drives it.
 *
 * This module is deliberately **free of any `@convex-dev/resend` types** so it
 * is safe to import from the password provider's sources, which every password
 * app typechecks — including apps that never mount email validation and so have
 * no `resend` dependency installed. The resend types live only in `setup.ts`,
 * which such apps never import.
 */

// The minimal shape of the app's `users` table that email validation depends
// on: a nullable `email` plus a `by_email` index to enforce uniqueness at
// confirmation time.
type UsersTableWithEmail = {
  document: { email?: string };
  indexes: { by_email: ["email", "_creationTime"] };
};

/**
 * The app DataModel constraint email validation requires. Used as the bound on
 * the `emailValidation<DataModel>()` type argument. Note this constraint alone
 * is *not* sufficient to force `email` to be optional (a required `email:
 * string` is still assignable to `email?: string`); `setup.ts` adds a second
 * conditional that closes that gap.
 */
export type DataModelWithVerifiableEmail = GenericDataModel & {
  users: UsersTableWithEmail;
};

/**
 * The resolved options the password provider consumes to run the
 * email-validation flow. Produced by the `emailValidation()` helper in
 * `setup.ts`; the `sendEmailRef` is intentionally loosely typed (it is a
 * `FunctionReference` to resend's `lib.sendEmail`) so this module stays
 * resend-free.
 */
export type EmailValidationOptions = {
  /** The mounted email-validation component (`components.authEmailValidation`). */
  component: ComponentApi;
  /** A `FunctionReference` to the mounted resend component's `lib.sendEmail`. */
  sendEmailRef: unknown;
  /** The `From` header for validation emails, e.g. `"My App <auth@x.com>"`. */
  from: string;
  /** Resend API key; defaults to `process.env.RESEND_API_KEY` at call time. */
  apiKey?: string;
  /** Resend test mode; defaults to `true` (matching resend's own default). */
  testMode?: boolean;
};
