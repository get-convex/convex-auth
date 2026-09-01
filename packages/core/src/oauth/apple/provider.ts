import { v } from "convex/values";
import { env, internalMutation, mutation } from "./_generated/server.ts";
import type { Doc } from "./_generated/dataModel.ts";
import * as db from "../shared/db.ts";

/**
 * Record an in-flight authorization request. Returns the Services ID and the
 * callback URL, which the caller needs for the authorization URL.
 */
export const createAuthorizationRequest = mutation({
  args: {
    stateHash: v.string(),
    redirectTo: v.string(),
  },
  returns: v.object({
    clientId: v.string(),
    callbackUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const { callbackUrl } = await db.insertAuthorizationRequest<
      Doc<"authorizationRequests">
    >(ctx, args);
    return { clientId: env.CLIENT_ID, callbackUrl };
  },
});

/** Claim the authorization request Apple's callback is answering. */
export const claimAuthorizationRequest = internalMutation({
  args: {
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      expired: v.literal(true),
      redirectTo: v.string(),
    }),
    v.object({
      expired: v.literal(false),
      stateHash: v.string(),
      redirectTo: v.string(),
      callbackUrl: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const claimed = await db.claimAuthorizationRequest<
      Doc<"authorizationRequests">
    >(ctx, args.stateHash);
    if (claimed === null) {
      return null;
    }
    if (claimed.expired) {
      return { expired: true as const, redirectTo: claimed.redirectTo };
    }
    const { doc } = claimed;
    return {
      expired: false as const,
      stateHash: doc.stateHash,
      redirectTo: doc.redirectTo,
      callbackUrl: doc.callbackUrl,
    };
  },
});

/** Store a one-time redeemable ticket after a successful code exchange. */
export const createTicket = internalMutation({
  args: {
    stateHash: v.string(),
    ticketCodeHash: v.string(),
    encryptedPayload: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) =>
    await db.insertTicket<Doc<"tickets">>(ctx, args),
});

/** Claim a ticket by hash, presenting the state minted at sign-in. */
export const claimTicket = mutation({
  args: {
    ticketCodeHash: v.string(),
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      encryptedPayload: v.string(),
    }),
  ),
  handler: async (ctx, args) => await db.claimTicket<Doc<"tickets">>(ctx, args),
});
