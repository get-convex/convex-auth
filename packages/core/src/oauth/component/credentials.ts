import { env } from "./_generated/server";

/**
 * Providers this component serves. Drives both the credential lookup here and
 * the callback routes in http.ts, so adding a provider is: extend this list,
 * add its `<PROVIDER>_CLIENT_ID`/`_SECRET` slots to convex.config.ts, and ship
 * its app-side catalog (e.g. `oauth/google.ts`).
 */
export const SUPPORTED_PROVIDERS = ["google", "github"] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** The env binding names each provider's credentials come from. */
const CREDENTIAL_BINDINGS = {
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
} as const;

/** Narrow an arbitrary provider string to a {@link SupportedProvider}. */
export function isSupportedProvider(
  provider: string,
): provider is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Resolve the client credentials for one provider from the mount's env
 * bindings. Read here (not at module scope) so a provider with no bound
 * credentials only fails when it's actually used.
 *
 * The env declaration makes every pair optional, so an app can bind only the
 * providers it uses. That moves the "did you bind this provider?" check from
 * push time to here, the first sign-in: the app-side `provider(...)` wiring
 * can't see the component's mount bindings, so it can't catch a wired-but-
 * unbound provider earlier. The error names the exact bindings to add.
 */
export function getCredentials(provider: string): {
  clientId: string;
  clientSecret: string;
} {
  if (!isSupportedProvider(provider)) {
    throw new Error(
      `Unsupported OAuth provider "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }
  const bindings = CREDENTIAL_BINDINGS[provider];
  const clientId = env[bindings.id];
  const clientSecret = env[bindings.secret];
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing credentials for OAuth provider "${provider}". Bind ${bindings.id} and ${bindings.secret} on the oauth mount in convex.config.ts.`,
    );
  }
  return { clientId, clientSecret };
}
