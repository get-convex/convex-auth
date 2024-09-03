import { GenericId } from "convex/values";
import { ConvexAuthConfig } from "../index.js";
import { SignJWT, importPKCS8 } from "jose";
import { requireEnv } from "../utils.js";
import { TOKEN_SUB_CLAIM_DIVIDER } from "./utils.js";

const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60; // 1 hour

export async function generateToken(
  args: {
    userId: GenericId<"users">;
    sessionId: GenericId<"authSessions">;
  },
  config: ConvexAuthConfig,
) {
  const privateKey = await importPKCS8(requireEnv("JWT_PRIVATE_KEY"), "RS256");
  const expirationTime = new Date(
    Date.now() + (config.jwt?.durationMs ?? DEFAULT_JWT_DURATION_MS),
  );
  return await new SignJWT({
    sub: args.userId + TOKEN_SUB_CLAIM_DIVIDER + args.sessionId,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(requireEnv("CONVEX_SITE_URL"))
    .setAudience("convex")
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}
