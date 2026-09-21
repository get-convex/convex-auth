import { convexTest, type TestConvex } from "convex-test";
import schema from "./email/schema.ts";
import { normalizeEmail } from "./email/validation.ts";
import { sha256Hex } from "../lib/crypto.ts";

export const modules = import.meta.glob("./email/**/*.ts");

/** Make a test instance of the component. */
export function setup(): TestConvex<typeof schema> {
  return convexTest(schema, modules);
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
  | { kind: "setPrimaryEmail"; userId: string };

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
