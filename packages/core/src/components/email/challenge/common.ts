/**
 * The server code that the challenge kinds share.
 *
 * Challenges prove that the current user has access to an email address.
 * Each challenge has two steps: creating it (which sends the email),
 * and then completing it (which receives the code in the email).
 *
 * There are two secrets for each challenge:
 *
 * - The `emailCode`, which travels in the emailed link.
 * - The `browserSecret`, which stays in the browser that started the challenge
 *   (either in page’s temporary state, or in local storage).
 *   The browser gets it from the `start` mutation and keeps it the page state
 *   (e.g. `useState`) for single-page flows, or local storage for multiple-page
 *   flows.
 *
 * Because both secrets are necessary, a person who reads the mailbox alone cannot
 * complete the challenge (which avoids attacks where a malicious user tricks the user
 * into completing a challenge for an account they control), and neither can a person
 * who uses the browser alone but doesn’t have access to the email address.
 *
 * The start step makes the row and sends the link:
 *
 * ```
 *  Client                    Provider                        Component
 *    │                         │                               │
 *    │  submit the address     │                               │
 *    ├────────────────────────▶│                               │
 *    │                         │  challenge start mutation     │
 *    │                         ├──────────────────────────────▶│     check the format, then the rate limits
 *    │                         │                               │     store the hashes of the code and the secret
 *    │                         │                               ├─▶ send the link by email
 *    │                         │◀──────────────────────────────┤     the secret and the ID of the challenge
 *    │◀────────────────────────┤                               │
 *    ├─▶ keep the secret in page state/local storage           │
 *    │                         │                               │
 * ```
 *
 * The completion step runs when the landing page opens with a link. The page
 * reads the code from the URL and the secret from storage, then completes at
 * once:
 *
 * ```
 *  Landing page                Provider                          Component
 *    │                           │                                 │
 *    ├─▶ read the code from the URL and the secret from storage    │
 *    │                           │                                 │
 *    │  complete                 │                                 │
 *    ├──────────────────────────▶│                                 │
 *    │                           │  challenge complete mutation    │
 *    │                           ├────────────────────────────────▶│     find the row by the secret, then verify the code
 *    │                           │                                 │     delete the row, then make the change that the kind defines
 *    │                           │◀────────────────────────────────┤
 *    │◀──────────────────────────┤                                 │
 *    ├─▶ show the result                                           │
 *    │                           │                                 │
 * ```
 *
 * The `purpose` of the row says which kind started the challenge, and which
 * user the flow is for. A `complete` call gives the purpose that it expects,
 * thus a link for one flow can never complete another flow, or a flow for
 * another user.
 *
 * The secret identifies the challenge, and the code proves access to the
 * mailbox. The row goes away only when the claim succeeds, thus no link works
 * twice, and a person who has only the link cannot burn the challenge. A
 * missing or expired row gives `INVALID_CHALLENGE`, and a wrong code gives
 * `INCORRECT_CODE`. A purpose mismatch throws, because it is an application
 * bug and not a user error.
 *
 * @module
 */

import { Infer, v } from "convex/values";
import type { MutationCtx } from "../_generated/server.ts";
import type { Doc, Id } from "../_generated/dataModel.ts";
import { generateRandomToken, sha256Hex } from "../../../lib/crypto.ts";
import { scheduleChallengeCleanup } from "../cleanup.ts";
import {
  startChallengeUserError,
  completeChallengeUserError,
} from "../validation.ts";

export type ChallengePurpose = Doc<"challenges">["purpose"];

//------------------------------------------------------------------------------
// Shared validators
//------------------------------------------------------------------------------

/** The arguments that every `start` mutation accepts. */
export const vStartArgs = {
  email: v.string(),
};

/** The arguments that every `complete` mutation accepts. */
export const vClaimArgs = {
  // The code from the emailed link.
  emailCode: v.string(),
  // The secret that the starting browser kept.
  browserSecret: v.string(),
};

export const startChallengeResult = v.union(
  v.object({
    success: v.literal(true),
    // The secret the client must keep (in its local storage) and present
    // again at completion. It never travels in the email.
    browserSecret: v.string(),
    // The new challenge. A caller that wants to keep data about the flow can
    // use this ID as a foreign reference.
    challengeId: v.id("challenges"),
  }),
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);
export type StartChallengeResult = Infer<typeof startChallengeResult>;

export const completeChallengeFailure = v.object({
  success: v.literal(false),
  userError: completeChallengeUserError,
});

export type CompleteChallengeFailure = Infer<typeof completeChallengeFailure>;

/**
 * The result of `claimChallenge`. The kinds return `failure` as-is when the
 * claim fails; it already has the shape of a failed `complete` result.
 */
export type ClaimChallengeResult =
  | { ok: true; row: Doc<"challenges"> }
  | { ok: false; failure: CompleteChallengeFailure };

function claimFailure(
  error: CompleteChallengeFailure["userError"]["error"],
): ClaimChallengeResult {
  return { ok: false, failure: { success: false, userError: { error } } };
}

//------------------------------------------------------------------------------
// Start
//------------------------------------------------------------------------------

/**
 * Store the hashed code + secret. Returns the secret that the starting
 * browser keeps, and the ID of the new row.
 */
export async function createChallenge(
  ctx: MutationCtx,
  args: {
    email: string;
    purpose: ChallengePurpose;
    ttlMs: number;
  },
): Promise<{ browserSecret: string; challengeId: Id<"challenges"> }> {
  const emailCode = generateRandomToken();
  const browserSecret = generateRandomToken();
  const challengeId = await ctx.db.insert("challenges", {
    email: args.email,
    purpose: args.purpose,
    emailCodeHash: await sha256Hex(emailCode),
    browserSecretHash: await sha256Hex(browserSecret),
    expiresAt: Date.now() + args.ttlMs,
  });
  await scheduleChallengeCleanup(ctx);
  return { browserSecret, challengeId };
}

//------------------------------------------------------------------------------
// Complete
//------------------------------------------------------------------------------

function samePurpose(a: ChallengePurpose, b: ChallengePurpose): boolean {
  return a.kind === b.kind && a.userId === b.userId;
}

/**
 * Claim a challenge with the code from the link and the secret from the
 * starting browser. Returns the row when the claim succeeds, or the failure
 * that the `complete` mutation returns to the client.
 *
 * The secret identifies the challenge, and the code proves access to the
 * mailbox. A caller without the secret cannot reach the row, so a person who
 * reads the mailbox alone can neither complete the challenge nor burn it.
 * The row is deleted only when the claim succeeds, so a claimed link can
 * never be replayed.
 *
 * `INVALID_CHALLENGE` means that there is no live challenge for the secret.
 * The challenge may have expired, may already have been used, or may never
 * have existed. The server cannot tell these apart, and the user action is
 * the same, start again. `INCORRECT_CODE` means the row exists but the code
 * is not the one that the challenge sent. For a link, the link is not the
 * newest one this browser started. For a future short code, it is a typo.
 *
 * A purpose mismatch (another kind, or another `userId`) throws. It is an
 * application bug: the landing page called the wrong function, or gave the
 * wrong user.
 */
export async function claimChallenge(
  ctx: MutationCtx,
  args: { emailCode: string; browserSecret: string; purpose: ChallengePurpose },
): Promise<ClaimChallengeResult> {
  const browserSecretHash = await sha256Hex(args.browserSecret);
  const row = await ctx.db
    .query("challenges")
    .withIndex("by_browserSecretHash", (q) =>
      q.eq("browserSecretHash", browserSecretHash),
    )
    .unique();
  if (
    row === null ||
    // At exactly `expiresAt` the link is expired, like in the cleanup loop.
    row.expiresAt <= Date.now()
  ) {
    return claimFailure("INVALID_CHALLENGE");
  }
  if (row.emailCodeHash !== (await sha256Hex(args.emailCode))) {
    return claimFailure("INCORRECT_CODE");
  }
  if (!samePurpose(row.purpose, args.purpose)) {
    throw new Error(
      `Challenge purpose mismatch: the row is for "${row.purpose.kind}", but the complete call expects "${args.purpose.kind}"`,
    );
  }
  await ctx.db.delete("challenges", row._id);
  return { ok: true, row };
}
