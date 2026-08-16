/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    challenge: {
      checkStart: FunctionReference<
        "mutation",
        "internal",
        { email: string },
        { ok: true } | { ok: false; retryAfterMs: number },
        Name
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
        { code: string; secret: string },
        | { email: string; isPrimary: boolean; success: true; userId: string }
        | {
            success: false;
            userError: { error: "INVALID_LINK" } | { error: "EMAIL_TAKEN" };
          },
        Name
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { code: string; secret: string },
        { email: string; status: "pending" } | { status: "invalid" },
        Name
      >;
      start: FunctionReference<
        "mutation",
        "internal",
        {
          email: string;
          emailSender: {
            apiKey: string;
            from: string;
            initialBackoffMs: number;
            kind: "resend";
            retryAttempts: number;
            sendEmailHandle: string;
            testMode: boolean;
          };
          url: string;
          userId: string;
        },
        | { secret: string; success: true }
        | {
            success: false;
            userError:
              | { error: "INVALID_EMAIL" }
              | { error: "EMAIL_TAKEN" }
              | { error: "RATE_LIMITED"; retryAfterMs: number };
          },
        Name
      >;
    };
    verifiedEmails: {
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      getEmails: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{ email: string; isPrimary: boolean }>,
        Name
      >;
      getUserIdByEmail: FunctionReference<
        "query",
        "internal",
        { email: string },
        { email: string; userId: string } | null,
        Name
      >;
    };
  };
