import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const totpAlgorithm = v.union(
  v.literal("SHA-1"),
  v.literal("SHA-256"),
  v.literal("SHA-512"),
);

export default defineSchema({
  // The TOTP secrets. A user has at most one `active` secret (the one that
  // sign-in codes are checked against) and at most one `pending` secret (a
  // new enrollment that the user has not confirmed yet). The component keeps
  // both properties true. Convex does not enforce unique indexes.
  //
  // The secret is stored as the component generated it.
  totpSecrets: defineTable({
    userId: v.string(),
    // The shared secret, as raw bytes. The server needs it to compute a code
    // to compare against what the client provided.
    // NOTE: Keeping the secret as raw bytes isn't ideal, but we deem it to be
    // a low security risk for a couple reasons.
    // 1. No component function returns the secret of an active TOTP. It
    //    remains securely encapsulated by the component API.
    // 2. It is a second factor and if it were leaked a first factor would need
    //    to be overcome before it could be used maliciously.
    // For future hardening, we might adopt a key ring approach and encrypt the
    // secrets here in the DB.
    secret: v.bytes(),
    // The parameters the codes are computed with. Stored per row so that a
    // change of the defaults never breaks an enrolled authenticator.
    algorithm: totpAlgorithm,
    digits: v.number(),
    // The time step, in seconds.
    period: v.number(),
    status: v.union(v.literal("pending"), v.literal("active")),
    // The time-step counter of the last code that was accepted. A code for
    // this counter or an earlier one is rejected, so that a code observed by
    // an attacker cannot be replayed within the validity window.
    lastUsedCounter: v.optional(v.number()),
  }).index("by_userId_status", ["userId", "status"]),

  // One row for each unused backup code of a user. A code is deleted when it
  // is used. Only the SHA-256 hash of the (normalized) code is stored.
  backupCodes: defineTable({
    userId: v.string(),
    codeHash: v.string(),
  }).index("by_userId_codeHash", ["userId", "codeHash"]),

  // One row for each pending sign-in attempt whose user has verified a code
  // (a TOTP code or a backup code). This is the proof that `checkSignIn`
  // reads back when the auth core continues the attempt, and the component is
  // the only writer: nothing outside it can mark an attempt as verified.
  //
  // The `attemptId` comes from the auth core, which hands out a new one for
  // each attempt and never reuses it, thus a row that outlives its attempt
  // satisfies nothing. Rows are transient: the component prunes them by age
  // (see SIGN_IN_VERIFICATION_TTL_MS) on each verification.
  signInVerifications: defineTable({
    attemptId: v.string(),
    userId: v.string(),
  }).index("by_attemptId", ["attemptId"]),
});
