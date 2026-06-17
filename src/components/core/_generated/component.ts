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
      authenticate: FunctionReference<
        "query",
        "internal",
        {
          claims: { profile: any; provider: string; providerAccountId: string };
        },
        {
          existingUserId?: string;
          profile: any;
          provider: string;
          providerAccountId: string;
        },
        Name
      >;
      linkAccount: FunctionReference<
        "mutation",
        "internal",
        {
          claims: { profile: any; provider: string; providerAccountId: string };
          userId: string;
        },
        { linked: boolean; userId: string },
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
          createUserHandle: string;
          issuer: string;
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
    };
  };
