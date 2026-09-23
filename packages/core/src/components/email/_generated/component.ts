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
      addEmail: {
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | { error: "EMAIL_TAKEN" }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          { browserSecret: string; emailCode: string; userId?: string },
          | { email: string; success: true; userId: string }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "EMAIL_TAKEN" };
            },
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
            };
            url: string;
            userId: string;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number }
                | { error: "EMAIL_TAKEN" };
            },
          Name
        >;
      };
      changeEmail: {
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | { error: "EMAIL_TAKEN" }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          { browserSecret: string; emailCode: string; userId: string },
          | {
              email: string;
              previousEmail: string | null;
              success: true;
              userId: string;
            }
          | {
              success: false;
              userError:
                | { error: "INVALID_CHALLENGE" }
                | { error: "INCORRECT_CODE" }
                | { error: "EMAIL_TAKEN" };
            },
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
            };
            url: string;
            userId: string;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number }
                | { error: "EMAIL_TAKEN" };
            },
          Name
        >;
      };
      custom: {
        check: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          | { error: "INVALID_EMAIL" }
          | { error: "RATE_LIMITED"; retryAfterMs: number }
          | null,
          Name
        >;
        complete: FunctionReference<
          "mutation",
          "internal",
          {
            browserSecret: string;
            emailCode: string;
            purpose: string;
            userId: string | null;
          },
          | { email: string; success: true; userId: string | null }
          | {
              success: false;
              userError:
                { error: "INVALID_CHALLENGE" } | { error: "INCORRECT_CODE" };
            },
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
            };
            intro: string;
            purpose: string;
            subject: string;
            ttlMs?: number;
            url: string;
            userId: string | null;
          },
          | { browserSecret: string; challengeId: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number };
            },
          Name
        >;
      };
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
      getPrimaryEmail: FunctionReference<
        "query",
        "internal",
        { userId: string },
        string | null,
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
