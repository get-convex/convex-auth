import { Doc } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";

// How long a stored challenge stays valid. The WebAuthn spec recommends
// ceremony timeouts of 5–10 minutes to leave room for user interaction
// (PIN entry, cross-device flows); we match the upper bound. Expiring
// challenges bounds the window for replay of an intercepted challenge.
// https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);
}

export function randomChallenge(): ArrayBuffer {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  return toArrayBuffer(challenge);
}

/**
 * Find a one-use challenge by its bytes. Make sure that the challenge has
 * the correct kind and is not too old. Delete the challenge and return the
 * row. Return `null` when no usable challenge exists (unknown, incorrect
 * kind, already used, or expired).
 */
export async function consumeChallenge(
  ctx: MutationCtx,
  kind: "registration" | "authentication",
  challenge: Uint8Array,
): Promise<Doc<"challenges"> | null> {
  const row = await ctx.db
    .query("challenges")
    .withIndex("by_challenge", (q) =>
      // It’s okay for this lookup to not be guaranteed to be constant-time:
      // knowing the challenge doesn’t prove anything, issuing a valid
      // assertion for that challenge does.
      q.eq("challenge", toArrayBuffer(challenge)),
    )
    .first();
  if (row === null || row.kind !== kind) {
    return null;
  }
  // One use only: a consumed (or expired) challenge is deleted.
  await ctx.db.delete("challenges", row._id);
  if (Date.now() - row.createdAt > CHALLENGE_TTL_MS) {
    return null;
  }
  return row;
}
