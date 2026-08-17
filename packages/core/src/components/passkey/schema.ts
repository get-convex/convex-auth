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
  // only: the finish step deletes it. A challenge expires a fixed time after
  // its creation (see CHALLENGE_TTL_MS), thus `_creationTime` is the age of
  // the challenge and the built-in `by_creation_time` index gives the
  // background cleanup loop (see cleanup.ts) the oldest challenges first.
  challenges: defineTable(
    v.union(
      v.object({
        kind: v.literal("registration"),
        challenge: v.bytes(), // 32 random bytes
      }),
      v.object({
        kind: v.literal("authentication"),
        challenge: v.bytes(),
        // The user that the challenge is for, if the app knows the user.
        // The field is not set for discoverable-credential ceremonies. In
        // that flow, the assertion identifies the user.
        userId: v.optional(v.string()),
      }),
    ),
  ).index("by_challenge", ["challenge"]),
});
