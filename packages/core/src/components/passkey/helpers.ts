import { Doc } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { CHALLENGE_TTL_MS } from "./validation";

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
  if (isChallengeExpired(row)) {
    return null;
  }
  return row;
}

/**
 * Tell if a stored challenge is too old to redeem.
 */
export function isChallengeExpired(
  row: Doc<"challenges">,
  now: number = Date.now(),
): boolean {
  // A challenge is valid for strictly less than the TTL: at exactly the
  // TTL, it is expired. The cleanup loop (see cleanup.ts) uses the same
  // boundary, so a wake-up at the deadline always finds work.
  return now - row.createdAt >= CHALLENGE_TTL_MS;
}
