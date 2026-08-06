import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row for each passkey credential. The component only sees an opaque
  // app `userId` string. It does not see usernames or email addresses.
  passkeys: defineTable({
    userId: v.string(),
    // A label that the user sets for this passkey. An app can show it in
    // a passkey list (for example, "MacBook Touch ID").
    name: v.optional(v.string()),
    // The raw credential ID bytes (the WebAuthn `rawId`).
    credentialId: v.bytes(),
    algorithm: v.union(v.literal("ES256"), v.literal("RS256")),
    // The encoded public key for signature checks. The format is a SEC1
    // uncompressed point for ES256, and PKCS#1 DER for RS256.
    publicKey: v.bytes(),
    // The signature counter. The value is 0 if the authenticator does not
    // use a counter. When the authenticator supports the counter, it is
    // expected to be always increasing. This component doesn’t enforce it,
    // but in theory this property could be used to detect cloned passkeys.
    counter: v.number(),
  })
    .index("by_credentialId", ["credentialId"])
    .index("by_userId", ["userId"]),

  // The WebAuthn challenges that are active. Each challenge is for one use
  // only: the finish step deletes it.
  challenges: defineTable(
    v.union(
      v.object({
        kind: v.literal("registration"),
        challenge: v.bytes(), // 32 random bytes
        createdAt: v.number(), // challenges expire (see CHALLENGE_TTL_MS)
      }),
      v.object({
        kind: v.literal("authentication"),
        challenge: v.bytes(),
        // The user that the challenge is for, if the app knows the user.
        // The field is not set for discoverable-credential ceremonies. In
        // that flow, the assertion identifies the user.
        userId: v.optional(v.string()),
        createdAt: v.number(),
      }),
    ),
  )
    .index("by_challenge", ["challenge"])
    // Used by the background cleanup loop (see cleanup.ts) to find the
    // challenges that are expired, oldest first.
    .index("by_createdAt", ["createdAt"])
    // Used by `deleteUser` to erase the authentication challenges that are
    // bound to a user. Registration rows have no `userId` field, so a probe
    // with a user ID string never matches them.
    .index("by_userId", ["userId"]),
});
