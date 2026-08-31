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
    public: {
      continueSignIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          attemptToken: string;
          onSignInHandle?: string;
          issuer: string;
          providerRequirements?: Array<{
            data?: any;
            factFields: Array<string>;
            kind: string;
          }>;
          refreshTokenTtlSeconds?: number;
        },
        | {
            status: "session-created";
            tokens: {
              accessToken: string;
              accessTokenExpiresAt: number;
              refreshToken: string;
              refreshTokenExpiresAt: number;
              userId: string;
            };
          }
        | {
            attemptToken: string;
            expiresAt: number;
            requirements: Array<{ data?: any; kind: string }>;
            status: "pending-requirements";
            userId: string;
          }
        | { status: "expired" },
        Name
      >;
      getAttemptContext: FunctionReference<
        "query",
        "internal",
        { attemptToken: string },
        {
          provider: string;
          providerAccountId: string;
          userId: string;
        } | null,
        Name
      >;
      getUserIdByAccount: FunctionReference<
        "query",
        "internal",
        { provider: string; providerAccountId: string },
        string | null,
        Name
      >;
      penalizeAttempt: FunctionReference<
        "mutation",
        "internal",
        { attemptToken: string },
        boolean,
        Name
      >;
      recordAttemptFacts: FunctionReference<
        "mutation",
        "internal",
        { attemptToken: string; facts: any; scope?: "app" | "provider" },
        boolean,
        Name
      >;
      refresh: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          issuer: string;
          refreshToken: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        } | null,
        Name
      >;
      signIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          claims: { profile: any; provider: string; providerAccountId: string };
          issuer: string;
          onSignInHandle?: string;
          providerRequirements?: Array<{
            data?: any;
            factFields: Array<string>;
            kind: string;
          }>;
          refreshTokenTtlSeconds?: number;
        },
        | {
            status: "session-created";
            tokens: {
              accessToken: string;
              accessTokenExpiresAt: number;
              refreshToken: string;
              refreshTokenExpiresAt: number;
              userId: string;
            };
          }
        | {
            attemptToken: string;
            expiresAt: number;
            requirements: Array<{ data?: any; kind: string }>;
            status: "pending-requirements";
            userId: string;
          },
        Name
      >;
      signOut: FunctionReference<
        "mutation",
        "internal",
        { refreshToken: string },
        null,
        Name
      >;
      signUp: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          claims: { profile: any; provider: string; providerAccountId: string };
          createUserHandle: string;
          issuer: string;
          onSignInHandle?: string;
          providerRequirements?: Array<{
            data?: any;
            factFields: Array<string>;
            kind: string;
          }>;
          refreshTokenTtlSeconds?: number;
        },
        | {
            status: "session-created";
            tokens: {
              accessToken: string;
              accessTokenExpiresAt: number;
              refreshToken: string;
              refreshTokenExpiresAt: number;
              userId: string;
            };
          }
        | {
            attemptToken: string;
            expiresAt: number;
            requirements: Array<{ data?: any; kind: string }>;
            status: "pending-requirements";
            userId: string;
          },
        Name
      >;
    };
  };
