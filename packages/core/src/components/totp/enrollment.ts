/**
 * TOTP enrollment: the functions of the component that a signed-in user
 * reaches from a settings page to set the second factor up.
 *
 * A user may have at most one TOTP in each of the "active" and "pending"
 * statuses. An active TOTP is one that the user confirmed with a valid code
 * generated from the shared secret. It should be used for authentication if
 * available (see {@link getStatus}). A pending TOTP is one that is awaiting a
 * call to {@link confirmTotp} to move it to the active status. It can be
 * confirmed for {@link PENDING_ENROLLMENT_TTL_MS} after its creation.
 *
 * @module
 */
import { mutation, query } from "./_generated/server.ts";
import { Infer, v } from "convex/values";
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  base32Encode,
  generateSecret,
  otpauthUri,
} from "./totp.ts";
import { confirmTotpUserError } from "./validation.ts";
import {
  backupCodesByUserId,
  matchCode,
  replaceBackupCodes,
  secretByStatus,
} from "./helpers.ts";

const createTotpResult = v.object({
  // The base32-encoded secret, for a user who types it into the authenticator
  // app by hand.
  secret: v.string(),
  // The `otpauth://` URI, for a QR code that the authenticator app scans.
  otpauthUri: v.string(),
});
type CreateTotpResult = Infer<typeof createTotpResult>;

// How long a pending secret can be confirmed after `createTotp` made it.
export const PENDING_ENROLLMENT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Start the TOTP enrollment of a user: generate a new secret.
 *
 * The new secret is *pending*: its use should not be enforced at sign-in until
 * the user proves that their authenticator has it, with `confirmTotp`.
 *
 * If a user already has an active TOTP enrolled, that one keeps working until
 * the new one is confirmed. If a pending enrollment was abandoned, a
 * subsequent call replaces it.
 *
 * `issuerDisplayName` names the application and `accountDisplayName` names the
 * account (for example the user's email address). Both are shown in the
 * authenticator app.
 */
export const createTotp = mutation({
  args: {
    userId: v.string(),
    issuerDisplayName: v.string(),
    accountDisplayName: v.string(),
  },
  returns: createTotpResult,
  handler: async (
    ctx,
    { userId, issuerDisplayName, accountDisplayName },
  ): Promise<CreateTotpResult> => {
    const secret = generateSecret();
    const params = {
      algorithm: DEFAULT_ALGORITHM,
      digits: DEFAULT_DIGITS,
      period: DEFAULT_PERIOD,
    };

    const pending = await secretByStatus(ctx, userId, "pending");
    if (pending !== null) {
      await ctx.db.delete("totpSecrets", pending._id);
    }
    await ctx.db.insert("totpSecrets", {
      userId,
      secret: secret.buffer,
      ...params,
      status: "pending",
    });

    const encodedSecret = base32Encode(secret);
    return {
      secret: encodedSecret,
      otpauthUri: otpauthUri({
        secret: encodedSecret,
        ...params,
        issuer: issuerDisplayName,
        accountName: accountDisplayName,
      }),
    };
  },
});

const confirmTotpResult = v.union(
  v.object({
    success: v.literal(true),
    // The new backup codes, in the form the user sees them. This is the only
    // time the component returns them: it stores only their hashes.
    backupCodes: v.array(v.string()),
  }),
  v.object({ success: v.literal(false), userError: confirmTotpUserError }),
);
type ConfirmTotpResult = Infer<typeof confirmTotpResult>;

/**
 * Finish the TOTP enrollment of a user: check a code against the pending
 * secret, and activate it.
 *
 * On success, the pending secret becomes the active secret of the user and
 * replaces the previous one, if any. The user gets a new set of backup codes,
 * which replaces the previous set. The code that confirmed the secret cannot
 * be used again to sign in.
 *
 * `NO_PENDING_ENROLLMENT` is for a user with no pending secret: the app has
 * not called `createTotp`, the enrollment was confirmed already (in another
 * tab, say), or it was created too long ago.
 */
export const confirmTotp = mutation({
  args: { userId: v.string(), code: v.string() },
  returns: confirmTotpResult,
  handler: async (ctx, { userId, code }): Promise<ConfirmTotpResult> => {
    const now = Date.now();
    const pending = await secretByStatus(ctx, userId, "pending");
    if (
      pending === null ||
      now - pending._creationTime >= PENDING_ENROLLMENT_TTL_MS
    ) {
      return { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } };
    }

    const matchedCounter = await matchCode(pending, code, now);
    if (matchedCounter === null) {
      return { success: false, userError: { error: "INVALID_CODE" } };
    }

    const active = await secretByStatus(ctx, userId, "active");
    if (active !== null) {
      await ctx.db.delete("totpSecrets", active._id);
    }
    await ctx.db.patch("totpSecrets", pending._id, {
      status: "active",
      lastUsedCounter: matchedCounter,
    });

    const backupCodes = await replaceBackupCodes(ctx, userId);
    return { success: true, backupCodes };
  },
});

const totpStatus = v.object({
  // `true` when the user has an active secret that they confirmed.
  enabled: v.boolean(),
  remainingBackupCodes: v.number(),
});
type TotpStatus = Infer<typeof totpStatus>;

/**
 * Get the TOTP status of a user.
 *
 * A pending enrollment is not reported: the app cannot resume one (the
 * secret is returned once, by `createTotp`), only start over.
 */
export const getStatus = query({
  args: { userId: v.string() },
  returns: totpStatus,
  handler: async (ctx, { userId }): Promise<TotpStatus> => {
    const [active, backupCodes] = await Promise.all([
      secretByStatus(ctx, userId, "active"),
      backupCodesByUserId(ctx, userId),
    ]);
    return {
      enabled: active !== null,
      remainingBackupCodes: backupCodes.length,
    };
  },
});
