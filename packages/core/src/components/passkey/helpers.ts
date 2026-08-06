import { Doc } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { constantTimeEqual } from "../../vendor/oslo/crypto/subtle";

// The time for which a stored challenge stays valid. A WebAuthn ceremony
// completes in seconds. An older challenge shows a stale tab or a replay
// attempt.
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
    .withIndex("by_challenge", (q) => q.eq("challenge", toArrayBuffer(challenge)))
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
