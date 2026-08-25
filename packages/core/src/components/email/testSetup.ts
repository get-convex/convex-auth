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
  | { kind: "addEmail"; userId: string }
  | { kind: "setPrimaryEmail"; userId: string }
  | { kind: "custom"; userId: string | null; purpose: string };

/**
 * Seed a pending challenge row directly, hashing the code and the secret
 * which convex-test does not supply.)
 */
export async function seedChallenge(
  t: TestConvex<typeof schema>,
  args: {
    email: string;
    purpose: ChallengePurposeRow;
    code: string;
    secret: string;
    expiresAt?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      purpose: args.purpose,
      codeHash: await sha256Hex(args.code),
      secretHash: await sha256Hex(args.secret),
      expiresAt: args.expiresAt ?? Date.now() + 60_000,
    });
  });
}

export function ADD_EMAIL(userId: string): ChallengePurposeRow {
  return { kind: "addEmail", userId };
}
export function SET_PRIMARY_EMAIL(userId: string): ChallengePurposeRow {
  return { kind: "setPrimaryEmail", userId };
}
export function CUSTOM(
  purpose: string,
  userId: string | null,
): ChallengePurposeRow {
  return { kind: "custom", userId, purpose };
}

/**
 * Make the keys of an `import.meta.glob("../**\/*.ts")` map that a test in a
 * subdirectory built relative to the component root.
 *
 * Vite writes the files of the test's own directory as `./file.ts`, but
 * convex-test resolves every module from the directory that holds
 * `_generated`, so those keys must read `../<subdir>/file.ts`.
 */
export function modulesFromSubdir<T>(
  modules: Record<string, T>,
  subdir: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(modules).map(([path, module]) => [
      path.startsWith("./") ? `../${subdir}/${path.slice(2)}` : path,
      module,
    ]),
  );
}
