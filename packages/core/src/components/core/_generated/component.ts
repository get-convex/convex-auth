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
      completePendingSignIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          attemptToken: string;
          issuer: string;
          refreshTokenTtlSeconds?: number;
        },
        | {
            status: "complete";
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
            requirements: Array<string>;
            status: "incomplete";
          }
        | null,
        Name
      >;
      createAccount: FunctionReference<
        "mutation",
        "internal",
        {
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          createUserHandle: string;
        },
        { userId: string },
        Name
      >;
      deferSignIn: FunctionReference<
        "mutation",
        "internal",
        {
          attemptTtlSeconds?: number;
          checks: Array<{ handle: string; requirement: string }>;
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          onSignInHandle?: string;
        },
        {
          attemptId: string;
          attemptToken: string;
          expiresAt: number;
          userId: string;
        },
        Name
      >;
      getPendingSignIn: FunctionReference<
        "query",
        "internal",
        { attemptToken: string },
        { attemptId: string; expiresAt: number; userId: string } | null,
        Name
      >;
      getUserIdByAccount: FunctionReference<
        "query",
        "internal",
        { provider: string; providerAccountId: string },
        string | null,
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
        | {
            kind: "rotated";
            tokens: {
              accessToken: string;
              accessTokenExpiresAt: number;
              refreshToken: string;
              refreshTokenExpiresAt: number;
              userId: string;
            };
          }
        | {
            accessToken: string;
            accessTokenExpiresAt: number;
            kind: "reused";
            refreshTokenExpiresAt: number;
            userId: string;
          }
        | { kind: "noSession" },
        Name
      >;
      signIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          issuer: string;
          onSignInHandle?: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
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
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          createUserHandle: string;
          issuer: string;
          onSignInHandle?: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        },
        Name
      >;
    };
  };
