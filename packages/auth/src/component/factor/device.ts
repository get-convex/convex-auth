/**
 * `component.factor.device.*` — OAuth 2.0 Device Authorization Grant
 * records (RFC 8628).
 *
 * Reads collapse into one overloaded `get`;
 * `authorize` is a kept domain verb (approval workflow).
 *
 * @module
 */

import { v } from "convex/values";

import { mutation, query } from "../functions";
import { vDeviceCodeDoc, vDeviceStatus } from "../model";

/**
 * Read a device-code record by `id`, by `deviceCodeHash`, or by `userCode`
 * (the last matches only a still-`pending` record).
 */
export const get = query({
  args: {
    id: v.optional(v.id("DeviceCode")),
    deviceCodeHash: v.optional(v.string()),
    userCode: v.optional(v.string()),
  },
  returns: v.union(vDeviceCodeDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.deviceCodeHash !== undefined) {
      return await ctx.db
        .query("DeviceCode")
        .withIndex("device_code_hash", (q) => q.eq("deviceCodeHash", args.deviceCodeHash!))
        .first();
    }
    if (args.userCode !== undefined) {
      return await ctx.db
        .query("DeviceCode")
        .withIndex("user_code_status", (q) =>
          q.eq("userCode", args.userCode!).eq("status", "pending"),
        )
        .first();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("DeviceCode", args.id);
  },
});

/** Insert a new device-code record. */
export const create = mutation({
  args: {
    deviceCodeHash: v.string(),
    userCode: v.string(),
    expiresAt: v.number(),
    interval: v.number(),
    status: vDeviceStatus,
  },
  returns: v.id("DeviceCode"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("DeviceCode", args);
  },
});

/**
 * Approve a device code with a `pending → authorized` compare-and-set and
 * create the polling device's Session in the SAME transaction. A retried or
 * concurrent verify that loses the transition creates no session, so an action
 * failure cannot strand the optimistic orphan the former create-then-CAS flow
 * had to clean up in a second mutation.
 */
export const authorize = mutation({
  args: {
    id: v.id("DeviceCode"),
    userId: v.id("User"),
    now: v.number(),
    sessionExpirationTime: v.number(),
  },
  returns: v.object({
    transitioned: v.boolean(),
    sessionId: v.optional(v.id("Session")),
  }),
  handler: async (ctx, { id: deviceId, userId, now, sessionExpirationTime }) => {
    const doc = await ctx.db.get("DeviceCode", deviceId);
    if (doc === null || doc.status !== "pending" || doc.expiresAt <= now) {
      return { transitioned: false };
    }
    const sessionId = await ctx.db.insert("Session", {
      userId,
      expirationTime: sessionExpirationTime,
    });
    await ctx.db.patch("DeviceCode", deviceId, {
      status: "authorized",
      userId,
      sessionId,
    });
    return { transitioned: true, sessionId };
  },
});

/**
 * Atomically accept an authorized device code: look it up by hash, and if it
 * is still `authorized`, unexpired, and carries a bound `userId`/`sessionId`,
 * delete it and return that binding. Any other state (missing, expired,
 * pending, denied, already accepted) returns `null`. Because the read, check,
 * and delete run in one transaction, two concurrent polls cannot both accept
 * the same code — only the winner receives the binding, so the device is
 * signed in exactly once.
 */
export const accept = mutation({
  args: { deviceCodeHash: v.string(), now: v.number() },
  returns: v.union(v.object({ userId: v.id("User"), sessionId: v.id("Session") }), v.null()),
  handler: async (ctx, { deviceCodeHash, now }) => {
    const doc = await ctx.db
      .query("DeviceCode")
      .withIndex("device_code_hash", (q) => q.eq("deviceCodeHash", deviceCodeHash))
      .first();
    if (doc === null || doc.status !== "authorized" || doc.expiresAt < now) {
      return null;
    }
    if (doc.userId === undefined || doc.sessionId === undefined) {
      return null;
    }
    await ctx.db.delete("DeviceCode", doc._id);
    return { userId: doc.userId, sessionId: doc.sessionId };
  },
});

/** Patch fields on a device-code record (e.g. status or `lastPolledAt`). */
export const update = mutation({
  args: {
    id: v.id("DeviceCode"),
    patch: v.object({
      status: v.optional(vDeviceStatus),
      userId: v.optional(v.id("User")),
      sessionId: v.optional(v.id("Session")),
      lastPolledAt: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: deviceId, patch }) => {
    await ctx.db.patch("DeviceCode", deviceId, patch);
    return null;
  },
});

/** Delete a device-code record. */
const remove = mutation({
  args: { id: v.id("DeviceCode") },
  returns: v.null(),
  handler: async (ctx, { id: deviceId }) => {
    await ctx.db.delete("DeviceCode", deviceId);
    return null;
  },
});

export { remove };
