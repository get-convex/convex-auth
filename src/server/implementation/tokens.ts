import { GenericId } from "convex/values";
import { importPKCS8, SignJWT } from "jose";
import { ConvexAuthConfig } from "../index.js";
import { requireEnv } from "../utils.js";
import { MutationCtx } from "./types.js";
import { TOKEN_SUB_CLAIM_DIVIDER } from "./utils.js";

const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60; // 1 hour

export async function generateToken(
  ctx: MutationCtx,
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
  const jwtPayload = config.callbacks?.addClaimsToJWT ?
    await config.callbacks.addClaimsToJWT(ctx, args) : undefined;

  return await new SignJWT(jwtPayload)
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(args.userId + TOKEN_SUB_CLAIM_DIVIDER + args.sessionId)
    .setIssuedAt()
    .setIssuer(requireEnv("CONVEX_SITE_URL"))
    .setAudience("convex")
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}
