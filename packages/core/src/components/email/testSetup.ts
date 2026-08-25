import type { TestConvex } from "convex-test";
import type schema from "./schema.ts";
import { normalizeEmail } from "./validation.ts";
import { sha256Hex } from "../../lib/crypto.ts";

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
  { kind: "addEmail" } | { kind: "setPrimaryEmail" } | { kind: "passwordReset" };

/**
 * Seed a pending challenge row directly, hashing the code and the secret
 * like `challenge.start` would. (`challenge.start` itself needs `ctx.meta`,
 * which convex-test does not supply.)
 */
export async function seedChallenge(
  t: TestConvex<typeof schema>,
  args: {
    email: string;
    userId: string;
    purpose: ChallengePurposeRow;
    code: string;
    secret: string;
    expiresAt?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      normalizedEmail: normalizeEmail(args.email),
      userId: args.userId,
      purpose: args.purpose,
      codeHash: await sha256Hex(args.code),
      secretHash: await sha256Hex(args.secret),
      expiresAt: args.expiresAt ?? Date.now() + 60_000,
    });
  });
}

export const ADD_EMAIL: ChallengePurposeRow = { kind: "addEmail" };
export const SET_PRIMARY_EMAIL: ChallengePurposeRow = { kind: "setPrimaryEmail" };
