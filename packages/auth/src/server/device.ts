/**
 * Server-side device authorization flow logic (RFC 8628).
 */

import { ConvexError } from "convex/values";

import type { AuthTokens, SignInDeviceCodeResult, SignInSessionResult } from "../shared/results";
import { AuthFlowError, authFlowError } from "../shared/errors";
import { toConvexError } from "./errors";
import { getAuthenticatedUserIdOrNull } from "./identity/claims";
import { callSignIn } from "./mutations/calls";
import { generateRandomString, sha256 } from "./random";
import { sessionExpirationTime } from "./session/lifecycle";
import type { DeviceProviderConfig, GenericActionCtxWithAuthConfig } from "./types";
import { appUrlFromEnv } from "./url";
import {
  mutateDeviceRemove,
  mutateDeviceInsert,
  mutateDeviceUpdateLastPolled,
  queryDeviceByCodeHash,
  queryDeviceByUserCode,
} from "./component/factor/db";
import { type AuthDataModel, type SessionInfo } from "./types";

type EnrichedActionCtx = GenericActionCtxWithAuthConfig<AuthDataModel>;

const DEVICE_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DEVICE_CODE_LENGTH = 40;
const DEVICE_FLOWS = ["create", "poll", "verify"] as const;

type DeviceFlow = (typeof DEVICE_FLOWS)[number];

type DeviceParams = {
  flow?: string;
  deviceCode?: string;
  userCode?: string;
};

type DeviceResult =
  | SignInDeviceCodeResult
  | SignInSessionResult<SessionInfo<AuthTokens | null> | null>;

const deviceError = authFlowError;

const assertFlow = (flow: string): DeviceFlow => {
  if (DEVICE_FLOWS.includes(flow as DeviceFlow)) {
    return flow as DeviceFlow;
  }
  throw deviceError(
    "DEVICE_MISSING_FLOW",
    "Missing `flow` parameter. Expected one of: create, poll, verify",
  );
};

async function handleCreate(
  ctx: EnrichedActionCtx,
  provider: DeviceProviderConfig,
): Promise<DeviceResult> {
  const deviceCode = generateRandomString(DEVICE_CODE_LENGTH, DEVICE_CODE_ALPHABET);
  const deviceCodeHash = await sha256(deviceCode);

  const rawUserCode = generateRandomString(provider.userCodeLength, provider.charset);
  const mid = Math.floor(rawUserCode.length / 2);
  const userCode = rawUserCode.slice(0, mid) + "-" + rawUserCode.slice(mid);

  const expiresAt = Date.now() + provider.expiresIn * 1000;
  await mutateDeviceInsert(ctx, {
    deviceCodeHash,
    userCode,
    expiresAt,
    interval: provider.interval,
    status: "pending",
  });

  const verificationUri = provider.verificationUri ?? `${appUrlFromEnv()}/device`;

  return {
    kind: "deviceCode" as const,
    deviceCode: {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
      expiresIn: provider.expiresIn,
      interval: provider.interval,
    },
  };
}

async function handlePoll(ctx: EnrichedActionCtx, params: DeviceParams): Promise<DeviceResult> {
  if (typeof params.deviceCode !== "string") {
    throw deviceError("DEVICE_MISSING_FLOW", "Missing `deviceCode` parameter for poll flow.");
  }

  const hash = await sha256(params.deviceCode);
  const doc = await queryDeviceByCodeHash(ctx, hash);
  if (doc === null) {
    throw deviceError(
      "DEVICE_CODE_EXPIRED",
      "The device code has expired. Please start a new authorization request.",
    );
  }
  if (Date.now() > doc.expiresAt) {
    await mutateDeviceRemove(ctx, doc._id);
    throw deviceError(
      "DEVICE_CODE_EXPIRED",
      "The device code has expired. Please start a new authorization request.",
    );
  }
  if (doc.lastPolledAt !== undefined && (Date.now() - doc.lastPolledAt) / 1000 < doc.interval) {
    throw deviceError(
      "DEVICE_SLOW_DOWN",
      "Polling too frequently. Increase the interval between requests.",
    );
  }

  await mutateDeviceUpdateLastPolled(ctx, doc._id, Date.now());

  if (doc.status === "pending") {
    throw deviceError(
      "DEVICE_AUTHORIZATION_PENDING",
      "The user has not yet authorized this device.",
    );
  }
  if (doc.status === "denied") {
    await mutateDeviceRemove(ctx, doc._id);
    throw deviceError("DEVICE_CODE_DENIED", "The authorization request was denied.");
  }

  const accepted = await ctx.runMutation(ctx.auth.config.component.factor.device.accept, {
    deviceCodeHash: hash,
    now: Date.now(),
  });
  if (accepted === null) {
    throw deviceError(
      "DEVICE_AUTHORIZATION_PENDING",
      "The user has not yet authorized this device.",
    );
  }

  const signInResult = await callSignIn(ctx, {
    userId: accepted.userId,
    sessionId: accepted.sessionId,
    generateTokens: true,
  });
  return { kind: "signedIn" as const, session: signInResult };
}

async function handleDeviceVerify(
  ctx: EnrichedActionCtx,
  params: DeviceParams,
): Promise<DeviceResult> {
  if (typeof params.userCode !== "string") {
    throw deviceError("DEVICE_INVALID_USER_CODE", "Missing `userCode` parameter for verify flow.");
  }

  const userId = await getAuthenticatedUserIdOrNull(ctx);
  if (userId === null) {
    throw deviceError("NOT_SIGNED_IN", "You must be signed in to authorize a device.");
  }
  const doc = await queryDeviceByUserCode(ctx, params.userCode);
  if (doc === null) {
    throw deviceError("DEVICE_INVALID_USER_CODE", "Invalid or expired user code.");
  }
  if (Date.now() > doc.expiresAt) {
    await mutateDeviceRemove(ctx, doc._id);
    throw deviceError(
      "DEVICE_CODE_EXPIRED",
      "The device code has expired. Please start a new authorization request.",
    );
  }
  if (doc.status !== "pending") {
    throw deviceError("DEVICE_ALREADY_AUTHORIZED", "This device code has already been authorized.");
  }

  // Mint the session the polling device will later adopt, then let the
  // `authorize` compare-and-set decide the winner. The CAS is the
  // serialization point: only a still-`pending` code transitions, so a
  // concurrent or retried verify that loses the race is rolled back below and
  // never leaves an orphan Session.
  //
  // The session is created directly (not via `callSignIn`) on purpose: the
  // device must receive its OWN fresh session rather than have the approving
  // user's current session replaced out from under them, and the session must
  // not become durable unless this call wins the CAS.
  const deviceSession = (await ctx.runMutation(ctx.auth.config.component.session.create, {
    userId,
    sessionExpirationTime: sessionExpirationTime(ctx.auth.config),
  })) as { sessionId: string };
  const { transitioned } = await ctx.runMutation(
    ctx.auth.config.component.factor.device.authorize,
    {
      id: doc._id,
      userId,
      sessionId: deviceSession.sessionId,
    },
  );
  if (!transitioned) {
    // Lost the race (or a retry of an already-authorized code): drop the
    // session we optimistically minted so it cannot survive as an orphan.
    await ctx.runMutation(ctx.auth.config.component.session.remove, {
      id: deviceSession.sessionId,
    });
    throw deviceError("DEVICE_ALREADY_AUTHORIZED", "This device code has already been authorized.");
  }
  return { kind: "signedIn" as const, session: null };
}

/** @internal */
export const handleDevice = async (
  ctx: EnrichedActionCtx,
  provider: DeviceProviderConfig,
  args: { params?: DeviceParams },
): Promise<DeviceResult> => {
  try {
    const params = args.params ?? {};
    const flow = assertFlow(typeof params.flow === "string" ? params.flow : "create");

    const flowHandlers = new Map<string, () => Promise<DeviceResult>>([
      ["create", () => handleCreate(ctx, provider)],
      ["poll", () => handlePoll(ctx, params)],
      ["verify", () => handleDeviceVerify(ctx, params)],
    ]);

    const handler = flowHandlers.get(flow)!;
    return await handler();
  } catch (error) {
    if (error instanceof ConvexError) {
      throw error;
    }
    if (error instanceof AuthFlowError) {
      throw toConvexError(error);
    }
    if (error instanceof Error) {
      throw toConvexError(authFlowError("INTERNAL_ERROR", `Device flow failed: ${error.message}`));
    }
    throw toConvexError(error);
  }
};
