/**
 * Small string helpers shared across the core, its provider components, and the
 * browser clients.
 *
 * @module
 */

/**
 * Uppercase the first character, preserving the string's literal type. Used to
 * derive the provider-suffixed API keys (`startSignIn` + `Google`) on both the
 * server (where the keys are minted) and the client (where they're resolved),
 * so the two sides can never disagree on the casing.
 */
export function capitalize<S extends string>(value: S): Capitalize<S> {
  return (value.charAt(0).toUpperCase() + value.slice(1)) as Capitalize<S>;
}

/**
 * Lowercase the first character, preserving the string's literal type. The
 * inverse of {@link capitalize}: recovers a provider name from a suffixed key
 * (`signInAzureAd` → `azureAd`).
 */
export function uncapitalize<S extends string>(value: S): Uncapitalize<S> {
  return (value.charAt(0).toLowerCase() + value.slice(1)) as Uncapitalize<S>;
}
