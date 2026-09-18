/**
 * Helpers over the tables of the component, for its public functions.
 *
 * @module
 */
import { Doc } from "./_generated/dataModel.ts";
import { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { hotp, timingSafeEqual, totpCounter } from "./totp.ts";
import { generateBackupCodes, hashBackupCode } from "./backupCodes.ts";
import { isWellFormedCode, normalizeCode } from "./validation.ts";

// The number of time steps of clock drift the verification tolerates, on each
// side of the current step (RFC 6238, section 5.2). One step each way accepts
// the previous and the next code with the current one, thus a code stays valid
// for at least 30 seconds after the authenticator showed it.
const WINDOW_STEPS = 1;

/**
 * Find the time step within the window whose code is `code`, or `null` when
 * no step matches.
 *
 * The steps are checked from the oldest to the newest, and the code of each
 * step is compared in constant time.
 */
export async function matchCode(
  secret: Doc<"totpSecrets">,
  code: string,
  nowMs: number,
): Promise<number | null> {
  const normalized = normalizeCode(code);
  if (!isWellFormedCode(normalized, secret.digits)) {
    return null;
  }
  const secretBytes = new Uint8Array(secret.secret);
  const currentCounter = totpCounter(nowMs, secret.period);
  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step++) {
    const counter = currentCounter + step;
    const expected = await hotp(secretBytes, counter, secret);
    if (timingSafeEqual(expected, normalized)) {
      return counter;
    }
  }
  return null;
}

/**
 * Delete the backup codes of a user and store a new set. Return the new codes
 * in the form the user sees them.
 */
export async function replaceBackupCodes(
  ctx: MutationCtx,
  userId: string,
): Promise<string[]> {
  for (const row of await backupCodesByUserId(ctx, userId)) {
    await ctx.db.delete("backupCodes", row._id);
  }
  const codes = generateBackupCodes();
  for (const code of codes) {
    await ctx.db.insert("backupCodes", {
      userId,
      codeHash: await hashBackupCode(code),
    });
  }
  return codes;
}

export function secretByStatus(
  ctx: QueryCtx,
  userId: string,
  status: "pending" | "active",
): Promise<Doc<"totpSecrets"> | null> {
  return ctx.db
    .query("totpSecrets")
    .withIndex("by_userId_status", (q) =>
      q.eq("userId", userId).eq("status", status),
    )
    .unique();
}

export function backupCodesByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"backupCodes">[]> {
  return ctx.db
    .query("backupCodes")
    .withIndex("by_userId_codeHash", (q) => q.eq("userId", userId))
    .collect();
}
