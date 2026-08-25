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
      custom: {
        complete: FunctionReference<
          "mutation",
          "internal",
          {
            code: string;
            purpose: string;
            secret: string;
            userId: string | null;
          },
          | { email: string; success: true; userId: string | null }
          | { success: false; userError: { error: "INVALID_LINK" } },
          Name
        >;
        getStatus: FunctionReference<
          "query",
          "internal",
          {
            code: string;
            purpose: string;
            secret: string;
            userId: string | null;
          },
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
            intro: string;
            purpose: string;
            subject: string;
            ttlMs?: number;
            url: string;
            userId: string | null;
          },
          | { challengeId: string; secret: string; success: true }
          | {
              success: false;
              userError:
                | { error: "INVALID_EMAIL" }
                | { error: "RATE_LIMITED"; retryAfterMs: number };
            },
          Name
        >;
      };
      rateLimit: {
        checkStart: FunctionReference<
          "mutation",
          "internal",
          { email: string },
          { ok: true } | { ok: false; retryAfterMs: number },
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
      getUserIdByEmail: FunctionReference<
        "query",
        "internal",
        { email: string },
        { email: string; userId: string } | null,
        Name
      >;
    };
  };
