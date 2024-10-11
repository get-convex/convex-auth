// This file maps to packages/core/src/lib/utils/providers.ts in the @auth/core package.

import { InternalProvider } from "../../types.js";

export function isOIDCProvider(
  provider: InternalProvider<"oidc" | "oauth">,
): provider is InternalProvider<"oidc"> {
  return provider.type === "oidc";
}
