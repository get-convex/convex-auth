import type { AuthConfig } from "convex/server";
import { env } from "./_generated/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "convex",
      issuer: env.CONVEX_SITE_URL,
      jwks: `${env.CONVEX_SITE_URL}/auth/.well-known/jwks.json`,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
