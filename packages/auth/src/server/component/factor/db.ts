/**
 * Typed cross-component wrappers for the factor (TOTP / passkey / device),
 * user, and PKCE-verifier stores.
 *
 * Each function routes through the shared {@link runQuery} / {@link runMutation}
 * boundary helpers and narrows the result to the domain doc type. Split out of
 * `types.ts` (which stays pure config types + inferred doc aliases) — these
 * carry runtime cross-component calls, mirroring the agent component's
 * `validators.ts`-vs-`execution.ts` separation.
 *
 * @module
 */

import type { GenericActionCtx } from "convex/server";
import type { Infer } from "convex/values";

import {
  vAuthVerifierDoc,
  vDeviceCodeDoc,
  vPasskeyDoc,
  vTotpFactorDoc,
} from "../../../component/model";
import type { AuthComponentApi } from "../api";
import type { AuthDataModel, CrossComponentUserDoc } from "../../types";

type TotpDoc = Infer<typeof vTotpFactorDoc>;

type PasskeyDoc = Infer<typeof vPasskeyDoc>;

type VerifierDoc = Infer<typeof vAuthVerifierDoc>;

type DeviceDoc = Infer<typeof vDeviceCodeDoc>;

/**
 * Structural context accepted by every cross-component wrapper below: read +
 * write (`runAction` optional so both action and mutation contexts fit) plus the
 * component API pulled off `ctx.auth.config.component` — the one wrapper family
 * that reads the API from the ctx rather than an explicit argument.
 *
 * @internal
 */
export type ComponentCallCtx = {
  runQuery: GenericActionCtx<AuthDataModel>["runQuery"];
  runMutation: GenericActionCtx<AuthDataModel>["runMutation"];
  runAction?: GenericActionCtx<AuthDataModel>["runAction"];
  auth: { config: { component: AuthComponentApi } };
};

/**
 * Fetch a user by ID across the component boundary.
 *
 * One of a family of typed wrappers that each encapsulate the single cast at
 * the component boundary, so callers keep full type safety on args and results.
 */
export async function queryUserById(
  ctx: ComponentCallCtx,
  userId: string,
): Promise<CrossComponentUserDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.user.get, {
    id: userId,
  })) as CrossComponentUserDoc | null;
}

/** Fetch a user by verified email across the component boundary. */
export async function queryUserByVerifiedEmail(
  ctx: ComponentCallCtx,
  email: string,
): Promise<CrossComponentUserDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.user.get, {
    verifiedEmail: email,
  })) as CrossComponentUserDoc | null;
}

/** Fetch a PKCE verifier by ID across the component boundary. */
export async function queryVerifierById(
  ctx: ComponentCallCtx,
  verifierId: string,
): Promise<VerifierDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.token.pkce.get, {
    id: verifierId,
  })) as VerifierDoc | null;
}

/** Remove a PKCE verifier by ID across the component boundary. */
export async function mutateVerifierRemove(
  ctx: ComponentCallCtx,
  verifierId: string,
): Promise<void> {
  await ctx.runMutation(ctx.auth.config.component.token.pkce.remove, {
    id: verifierId,
  });
}

/**
 * Atomically consume a PKCE verifier by ID across the component boundary,
 * returning the consumed doc to the single winner and `null` otherwise (unknown
 * / expired / signature mismatch / already consumed). Replaces the racy
 * read-then-remove so concurrent passkey/TOTP ceremonies cannot each consume the
 * same verifier and mint duplicate sessions. When `expectedSignature` is given,
 * the row is consumed only if its signature matches (a mismatch leaves it
 * intact).
 */
export async function consumeVerifierById(
  ctx: ComponentCallCtx,
  verifierId: string,
  expectedSignature?: string,
): Promise<VerifierDoc | null> {
  return (await ctx.runMutation(ctx.auth.config.component.token.pkce.consume, {
    id: verifierId,
    ...(expectedSignature === undefined ? {} : { expectedSignature }),
  })) as VerifierDoc | null;
}

/** Fetch a TOTP factor by ID across the component boundary. */
export async function queryTotpById(
  ctx: ComponentCallCtx,
  totpId: string,
): Promise<TotpDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.factor.totp.get, {
    id: totpId,
  })) as TotpDoc | null;
}

/** Fetch a user's verified TOTP factor across the component boundary. */
export async function queryTotpVerifiedByUserId(
  ctx: ComponentCallCtx,
  userId: string,
): Promise<TotpDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.factor.totp.get, {
    verifiedForUserId: userId,
  })) as TotpDoc | null;
}

/** Insert a TOTP factor across the component boundary; returns its ID. */
export async function mutateTotpInsert(
  ctx: ComponentCallCtx,
  args: {
    userId: string;
    secret: ArrayBuffer;
    digits: number;
    period: number;
    verified: boolean;
    name?: string;
    createdAt: number;
  },
): Promise<string> {
  return (await ctx.runMutation(ctx.auth.config.component.factor.totp.create, args)) as string;
}

/** Mark a TOTP factor verified across the component boundary. */
export async function mutateTotpMarkVerified(
  ctx: ComponentCallCtx,
  totpId: string,
  lastUsedAt: number,
): Promise<void> {
  await ctx.runMutation(ctx.auth.config.component.factor.totp.update, {
    id: totpId,
    patch: { verified: true, lastUsedAt },
  });
}

/** Update a TOTP factor's `lastUsedAt` across the component boundary. */
export async function mutateTotpUpdateLastUsed(
  ctx: ComponentCallCtx,
  totpId: string,
  lastUsedAt: number,
): Promise<void> {
  await ctx.runMutation(ctx.auth.config.component.factor.totp.update, {
    id: totpId,
    patch: { lastUsedAt },
  });
}

/** List a user's passkeys across the component boundary. */
export async function queryPasskeysByUserId(
  ctx: ComponentCallCtx,
  userId: string,
): Promise<PasskeyDoc[]> {
  return (await ctx.runQuery(ctx.auth.config.component.factor.passkey.list, {
    userId,
  })) as PasskeyDoc[];
}

/** Fetch a passkey by credential ID across the component boundary. */
export async function queryPasskeyByCredentialId(
  ctx: ComponentCallCtx,
  credentialId: string,
): Promise<PasskeyDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.factor.passkey.get, {
    credentialId,
  })) as PasskeyDoc | null;
}

/** Insert a passkey across the component boundary; returns its ID. */
export async function mutatePasskeyInsert(
  ctx: ComponentCallCtx,
  args: {
    userId: string;
    credentialId: string;
    publicKey: ArrayBuffer;
    algorithm: number;
    counter: number;
    transports?: string[];
    deviceType: string;
    backedUp: boolean;
    name?: string;
    createdAt: number;
  },
): Promise<string> {
  return (await ctx.runMutation(ctx.auth.config.component.factor.passkey.create, args)) as string;
}

/**
 * Atomically accept a passkey signature counter (anti-cloning) and update
 * `lastUsedAt` across the component boundary.
 */
export async function mutatePasskeyUpdateCounter(
  ctx: ComponentCallCtx,
  passkeyId: string,
  counter: number,
  lastUsedAt: number,
): Promise<boolean> {
  return (await ctx.runMutation(ctx.auth.config.component.factor.passkey.acceptAssertion, {
    id: passkeyId,
    counter,
    lastUsedAt,
  })) as boolean;
}

/** Insert a device-authorization record across the component boundary; returns its ID. */
export async function mutateDeviceInsert(
  ctx: ComponentCallCtx,
  args: {
    deviceCodeHash: string;
    userCode: string;
    expiresAt: number;
    interval: number;
    status: "pending" | "authorized" | "denied";
  },
): Promise<string> {
  return (await ctx.runMutation(ctx.auth.config.component.factor.device.create, args)) as string;
}

/** Fetch a device-authorization record by code hash across the component boundary. */
export async function queryDeviceByCodeHash(
  ctx: ComponentCallCtx,
  deviceCodeHash: string,
): Promise<DeviceDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.factor.device.get, {
    deviceCodeHash,
  })) as DeviceDoc | null;
}

/** Fetch a device-authorization record by user code across the component boundary. */
export async function queryDeviceByUserCode(
  ctx: ComponentCallCtx,
  userCode: string,
): Promise<DeviceDoc | null> {
  return (await ctx.runQuery(ctx.auth.config.component.factor.device.get, {
    userCode,
  })) as DeviceDoc | null;
}

/** Update a device-authorization record's `lastPolledAt` across the component boundary. */
export async function mutateDeviceUpdateLastPolled(
  ctx: ComponentCallCtx,
  deviceId: string,
  lastPolledAt: number,
): Promise<void> {
  await ctx.runMutation(ctx.auth.config.component.factor.device.update, {
    id: deviceId,
    patch: { lastPolledAt },
  });
}

/** Remove a device-authorization record by ID across the component boundary. */
export async function mutateDeviceRemove(ctx: ComponentCallCtx, deviceId: string): Promise<void> {
  await ctx.runMutation(ctx.auth.config.component.factor.device.remove, {
    id: deviceId,
  });
}
