import { v } from "convex/values";
import { env, internalMutation, mutation } from "./_generated/server.ts";
import type { Doc } from "./_generated/dataModel.ts";
import * as db from "../shared/db.ts";

/**
 * Record an in-flight authorization request. Called by the app-side
 * `signIn` before it redirects the user to the provider; the provider
 * callback later claims the request by state hash.
 *
 * Returns the provider's `CLIENT_ID` and the callback URL, which the caller
 * needs for the authorization URL.
 */
export const createAuthorizationRequest = mutation({
  args: {
    providerName: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    codeVerifier: v.optional(v.string()),
    tokenEndpoint: v.string(),
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    issuers: v.optional(v.array(v.string())),
  },
  returns: v.object({
    clientId: v.string(),
    callbackUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const { callbackUrl } = await db.insertAuthorizationRequest(ctx, args);
    return { clientId: env.CLIENT_ID, callbackUrl };
  },
});

/**
 * Claim the authorization request the provider's callback is answering.
 *
 * If the request record has expired, it is deleted and its `redirectTo` is
 * returned so the callback can send the user back to the app instead of
 * stranding them on an error page.
 */
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
      providerName: v.string(),
      stateHash: v.string(),
      redirectTo: v.string(),
      callbackUrl: v.string(),
      codeVerifier: v.optional(v.string()),
      tokenEndpoint: v.string(),
      userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
      issuers: v.optional(v.array(v.string())),
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
      providerName: doc.providerName,
      stateHash: doc.stateHash,
      redirectTo: doc.redirectTo,
      callbackUrl: doc.callbackUrl,
      codeVerifier: doc.codeVerifier,
      tokenEndpoint: doc.tokenEndpoint,
      userInfoEndpoints: doc.userInfoEndpoints,
      issuers: doc.issuers,
    };
  },
});

/**
 * Store a one-time redeemable ticket after a successful code exchange. The
 * caller (the callback) holds the raw ticket code; only its hash is
 * stored, and the identity payload arrives already encrypted with a key
 * derived from that code.
 */
export const createTicket = internalMutation({
  args: {
    providerName: v.string(),
    stateHash: v.string(),
    ticketCodeHash: v.string(),
    encryptedPayload: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => await db.insertTicket(ctx, args),
});

/**
 * Claim a ticket by ticket code hash: find, check, delete, and return it
 * in one transaction, so a replayed or raced redemption finds nothing.
 *
 * The caller must also present the hash of the state minted at sign-in,
 * binding redemption to the client that initiated the flow, and the provider
 * name it expects, so a misconfigured or renamed provider instance can't
 * redeem a ticket into the wrong account namespace.
 */
export const claimTicket = mutation({
  args: {
    providerName: v.string(),
    ticketCodeHash: v.string(),
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      encryptedPayload: v.string(),
    }),
  ),
  handler: async (ctx, args) =>
    await db.claimTicket<Doc<"tickets">>(ctx, {
      ticketCodeHash: args.ticketCodeHash,
      stateHash: args.stateHash,
      match: (ticket) => ticket.providerName === args.providerName,
    }),
});
