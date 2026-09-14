import { convexTest, type TestConvex } from "convex-test";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "./email/schema.ts";
import { normalizeEmail } from "./email/validation.ts";
import { sha256Hex } from "../lib/crypto.ts";

export const modules = import.meta.glob("./email/**/*.ts");

/**
 * Make a test instance of the component. The component mounts the batch
 * worker (the cleanup loop) and the rate limiter (the `start` throttle), so
 * register both with the test instance too.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  registerBatchWorker(t);
  registerRateLimiter(t);
  return t;
}

/** Seed a verified email row directly; the challenge arrives later. */
export async function seedEmail(
  t: TestConvex<typeof schema>,
  userId: string,
  email: string,
  isPrimary: boolean,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: normalizeEmail(email),
      userId,
      isPrimary,
    });
  });
}

export type ChallengePurposeRow =
  | { kind: "addEmail"; userId: string }
  | { kind: "setPrimaryEmail"; userId: string }
  | { kind: "custom"; userId: string | null; purpose: string };

/**
 * Seed a pending challenge row directly, with the hashes of the code and the
 * secret.
 */
export async function seedChallenge(
  t: TestConvex<typeof schema>,
  args: {
    email: string;
    purpose: ChallengePurposeRow;
    emailCode: string;
    browserSecret: string;
    expiresAt?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      purpose: args.purpose,
      emailCodeHash: await sha256Hex(args.emailCode),
      browserSecretHash: await sha256Hex(args.browserSecret),
      expiresAt: args.expiresAt ?? Date.now() + 60_000,
    });
  });
}

export function CUSTOM(
  purpose: string,
  userId: string | null,
): ChallengePurposeRow {
  return { kind: "custom", userId, purpose };
}
