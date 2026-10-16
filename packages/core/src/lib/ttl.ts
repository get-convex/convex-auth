// Defaults for the configurable token lifetimes. The app overrides them per
// deployment via `setupConvexAuth`, which threads the chosen values in as call
// args; when it passes nothing, these apply.
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * The token lifetimes for a call, with the app's overrides applied over the
 * defaults.
 */
export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

/**
 * Apply the defaults and validate the token lifetimes, so a misconfiguration
 * fails loudly rather than minting nonsensical sessions. `setupConvexAuth`
 * calls it when `convex/auth.ts` loads, thus a bad value fails at deploy
 * time; the core component checks the values again for each call.
 */
export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}): TtlConfig {
  const accessTokenTtlSeconds =
    args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTokenTtlSeconds =
    args.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  for (const [name, value] of [
    ["accessTokenTtlSeconds", accessTokenTtlSeconds],
    ["refreshTokenTtlSeconds", refreshTokenTtlSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Token TTLs must be positive: ${name} is ${value}. Check the ` +
          `options of setupConvexAuth.`,
      );
    }
  }
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
    throw new Error(
      `Access-token TTL must be shorter than the refresh-token TTL: ` +
        `accessTokenTtlSeconds is ${accessTokenTtlSeconds} and ` +
        `refreshTokenTtlSeconds is ${refreshTokenTtlSeconds}. Check the ` +
        `options of setupConvexAuth.`,
    );
  }
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}
