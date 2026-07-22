/**
 * Server-side TOTP ceremony logic for two-factor authentication.
 *
 * Two single-word flows:
 *
 * - `setup`  — generate a TOTP secret and `otpauth://` URI for enrollment.
 * - `verify` — consume a TOTP code. Auto-detects:
 *     - first-time enrollment confirmation (caller passes `totpId`), or
 *     - 2FA sign-in challenge (no `totpId`).
 */

import {
  decodeBase64urlIgnorePadding,
  encodeBase32LowerCaseNoPadding,
  encodeBase64urlNoPadding,
} from "@oslojs/encoding";
import { createTOTPKeyURI, verifyTOTPWithGracePeriod } from "@oslojs/otp";
import { ConvexError } from "convex/values";

import { ErrorCode } from "../shared/codes";
import { authFlowError } from "../shared/errors";
import type { AuthTokens, SignInSessionResult, SignInTotpSetupResult } from "../shared/results";
import type { AuthErrorData } from "./errors";
import { toConvexError } from "./errors";
import { emitAuthEvent } from "./events";
import { getAuthenticatedUserIdOrNull } from "./identity/claims";
import { reserveSignInAttempt, resetSignInRateLimit } from "./limits";
import { callSignIn, callVerifier } from "./mutations/calls";
import { decryptSecret, encryptSecret } from "./secret";
import {
  consumeVerifierById,
  mutateTotpInsert,
  mutateTotpMarkVerified,
  mutateTotpUpdateLastUsed,
  queryTotpById,
  queryTotpVerifiedByUserId,
  queryUserById,
  queryVerifierById,
} from "./component/factor/db";
import {
  AuthDataModel,
  GenericActionCtxWithAuthConfig,
  SessionInfo,
  TotpProviderConfig,
} from "./types";

type EnrichedActionCtx = GenericActionCtxWithAuthConfig<AuthDataModel>;

type TotpResult =
  | SignInSessionResult<SessionInfo<AuthTokens | null> | null>
  | SignInTotpSetupResult;

const TOTP_FLOWS = ["setup", "verify"] as const;

type TotpFlow = (typeof TOTP_FLOWS)[number];

type TotpDispatch =
  | { flow: "setup"; params: Record<string, unknown> }
  /** Enrollment confirmation — `totpId` distinguishes from a 2FA challenge. */
  | { flow: "verify"; code: string; verifier: string; totpId: string; intent: "enrollment" }
  /** 2FA challenge during sign-in. */
  | { flow: "verify"; code: string; verifier: string; totpId?: undefined; intent: "challenge" };

const convexError = (code: ErrorCode, message: string) =>
  toConvexError(authFlowError(code, message));

const asConvexError = (
  error: unknown,
  code: ErrorCode,
  message: string,
): ConvexError<AuthErrorData> =>
  error instanceof ConvexError
    ? error
    : error instanceof Error
      ? toConvexError(authFlowError(code, error.message || message))
      : convexError(code, message);

/**
 * Encrypt a raw TOTP secret for storage. The secret bytes are base64url-encoded
 * and sealed with the server's {@link encryptSecret} (AES-GCM); the resulting
 * ciphertext string is stored UTF-8-encoded in the `TotpFactor.secret` bytes
 * field. Runs server-side because component functions cannot read
 * `AUTH_SECRET_ENCRYPTION_KEY`.
 */
async function encryptTotpSecret(secret: Uint8Array): Promise<ArrayBuffer> {
  const ciphertext = await encryptSecret(encodeBase64urlNoPadding(secret));
  const encoded = new TextEncoder().encode(ciphertext);
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

/**
 * Reverse {@link encryptTotpSecret}: decode the stored ciphertext bytes, decrypt
 * to the base64url secret, and return the raw secret bytes for verification.
 */
async function decryptTotpSecret(stored: ArrayBuffer): Promise<Uint8Array> {
  const ciphertext = new TextDecoder().decode(stored);
  const secretB64 = await decryptSecret(ciphertext);
  return decodeBase64urlIgnorePadding(secretB64);
}

/**
 * Parse a verifier's stored signature into the TOTP ceremony payload.
 *
 * A verifier with a missing or non-JSON signature (e.g. one minted for a
 * different flow) is rejected with a clean `TOTP_INVALID_VERIFIER` rather than
 * surfacing a raw `JSON.parse`/null-deref error.
 */
function parseTotpVerifierData(signature: string | undefined): Record<string, unknown> {
  if (typeof signature !== "string") {
    throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
  }
  return parsed as Record<string, unknown>;
}

function resolveTotpFlow(params: Record<string, unknown>): TotpFlow {
  const flow = params.flow;
  if (typeof flow === "string" && (TOTP_FLOWS as readonly string[]).includes(flow)) {
    return flow as TotpFlow;
  }
  throw convexError(
    ErrorCode.TOTP_MISSING_FLOW,
    "Missing `flow` parameter. Expected one of: " + TOTP_FLOWS.join(", "),
  );
}

function requireTotpVerifier(verifier: string | undefined): string {
  if (verifier != null) {
    return verifier;
  }
  throw convexError(ErrorCode.TOTP_MISSING_VERIFIER, "Missing verifier for TOTP operation.");
}

function requireTotpCode(params: Record<string, unknown>): string {
  if (typeof params.code === "string") {
    return params.code;
  }
  throw convexError(ErrorCode.TOTP_MISSING_CODE, "Missing TOTP code.");
}

function resolveTotpDispatch(
  params: Record<string, unknown>,
  verifier: string | undefined,
): TotpDispatch {
  const flow = resolveTotpFlow(params);
  if (flow === "setup") {
    return { flow: "setup" as const, params };
  }
  const resolvedVerifier = requireTotpVerifier(verifier);
  const code = requireTotpCode(params);
  if (typeof params.totpId === "string" && params.totpId.length > 0) {
    return {
      flow: "verify" as const,
      code,
      totpId: params.totpId,
      verifier: resolvedVerifier,
      intent: "enrollment",
    };
  }
  return {
    flow: "verify" as const,
    code,
    verifier: resolvedVerifier,
    intent: "challenge",
  };
}

async function requireAuthenticatedUserId(ctx: EnrichedActionCtx): Promise<string> {
  try {
    const userId = await getAuthenticatedUserIdOrNull(ctx);
    if (userId === null) {
      throw convexError(
        ErrorCode.TOTP_AUTH_REQUIRED,
        "Sign in first, then set up two-factor authentication.",
      );
    }
    return userId;
  } catch (error) {
    if (error instanceof ConvexError) {
      throw error;
    }
    throw asConvexError(error, ErrorCode.INTERNAL_ERROR, String(error));
  }
}

/**
 * Drive the TOTP provider's `setup` / `verify` flow.
 *
 * `setup` issues an enrollment secret and `otpauth://` URI; `verify` either
 * confirms a first-time enrollment (when `params.totpId` is present) or
 * completes a 2FA challenge during sign-in.
 *
 * @internal
 */
export const handleTotp = async (
  ctx: EnrichedActionCtx,
  provider: TotpProviderConfig,
  args: { params?: Record<string, unknown>; verifier?: string },
): Promise<TotpResult> => {
  const params = (args.params ?? {}) as Record<string, unknown>;
  const dispatch = resolveTotpDispatch(params, args.verifier);

  const flowHandlers: Record<string, () => Promise<TotpResult>> = {
    setup: async () => {
      const { params: setupParams } = dispatch as { params: Record<string, unknown> };
      const userId = await requireAuthenticatedUserId(ctx);
      const secret = new Uint8Array(20);
      crypto.getRandomValues(secret);

      let accountName: string = setupParams.accountName as string;
      if (!accountName) {
        let user;
        try {
          user = await queryUserById(ctx, userId);
        } catch (error) {
          throw asConvexError(
            error,
            ErrorCode.INTERNAL_ERROR,
            `TOTP setup failed: ${String(error)}`,
          );
        }
        accountName = user?.email ?? "user";
      }

      const uri = createTOTPKeyURI(
        provider.options.issuer,
        accountName,
        secret,
        provider.options.period,
        provider.options.digits,
      );
      const base32Secret = encodeBase32LowerCaseNoPadding(secret);

      let totpId: string;
      try {
        totpId = await mutateTotpInsert(ctx, {
          userId,
          secret: await encryptTotpSecret(secret),
          digits: provider.options.digits,
          period: provider.options.period,
          verified: false,
          name: typeof setupParams.name === "string" ? setupParams.name : undefined,
          createdAt: Date.now(),
        });
      } catch (error) {
        throw asConvexError(error, ErrorCode.INTERNAL_ERROR, `TOTP setup failed: ${String(error)}`);
      }

      let verifier: string;
      try {
        verifier = await callVerifier(
          ctx,
          JSON.stringify({
            purpose: "totp.setup",
            userId,
            totpId,
            digits: provider.options.digits,
            period: provider.options.period,
          }),
        );
      } catch (error) {
        throw asConvexError(error, ErrorCode.INTERNAL_ERROR, `TOTP setup failed: ${String(error)}`);
      }

      return {
        kind: "totpSetup" as const,
        totpSetup: {
          uri,
          secret: base32Secret,
          totpId,
        },
        verifier,
      };
    },

    verify: async () => {
      if (dispatch.flow !== "verify") {
        throw convexError(ErrorCode.TOTP_MISSING_FLOW, `Unexpected dispatch: ${dispatch.flow}`);
      }
      if (dispatch.intent === "enrollment") {
        return await confirmEnrollment(dispatch.code, dispatch.totpId, dispatch.verifier);
      }
      return await verifyChallenge(dispatch.code, dispatch.verifier);
    },
  };

  /**
   * `verify` with `totpId`: completes a first-time enrollment after `setup`.
   * Marks the TOTP factor as verified and signs the user in.
   */
  async function confirmEnrollment(
    code: string,
    totpId: string,
    verifier: string,
  ): Promise<TotpResult> {
    const userId = await requireAuthenticatedUserId(ctx);
    let verifierDoc;
    try {
      verifierDoc = await queryVerifierById(ctx, verifier);
    } catch {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    if (verifierDoc === null) {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    const verifierData = parseTotpVerifierData(verifierDoc.signature ?? undefined);
    if (
      verifierData.purpose !== "totp.setup" ||
      verifierData.userId !== userId ||
      verifierData.totpId !== totpId
    ) {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    // Reserve (consume) a token up front so concurrent guesses cannot all clear
    // a non-consuming check before any failure commits — this is an action, so
    // each runQuery/runMutation is a separate transaction. Refunded on success.
    if (await reserveSignInAttempt(ctx, userId, ctx.auth.config)) {
      throw convexError(ErrorCode.RATE_LIMITED, "Too many TOTP attempts. Try again later.");
    }
    let doc;
    try {
      doc = await queryTotpById(ctx, totpId);
    } catch {
      throw convexError(ErrorCode.TOTP_NOT_FOUND, "TOTP enrollment not found.");
    }
    if (doc === null) {
      throw convexError(ErrorCode.TOTP_NOT_FOUND, "TOTP enrollment not found.");
    }
    if (doc.userId !== userId) {
      throw convexError(ErrorCode.TOTP_NOT_FOUND, "TOTP enrollment not found.");
    }
    if (doc.verified) {
      throw convexError(ErrorCode.TOTP_ALREADY_VERIFIED, "TOTP enrollment is already verified.");
    }
    const enrollmentSecret = await decryptTotpSecret(doc.secret);
    if (
      !verifyTOTPWithGracePeriod(
        enrollmentSecret,
        provider.options.period,
        provider.options.digits,
        code,
        30,
      )
    ) {
      // The reservation above already consumed this attempt's token; do not
      // double-record.
      throw convexError(ErrorCode.TOTP_INVALID_CODE, "Invalid TOTP code.");
    }
    // Atomically consume the verifier BEFORE minting a session: this runs in an
    // action, so two concurrent confirmations that both passed the earlier read
    // would otherwise each sign in (duplicate sessions). Only the single winner
    // gets the doc back; a loser (null) aborts here.
    if ((await consumeVerifierById(ctx, verifier)) === null) {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    // Only the verifier-consumption winner may refund the reserved attempt.
    await resetSignInRateLimit(ctx, userId, ctx.auth.config);
    let signInResult;
    try {
      await mutateTotpMarkVerified(ctx, totpId, Date.now());
      signInResult = await callSignIn(ctx, {
        userId,
        generateTokens: true,
      });
    } catch (error) {
      throw asConvexError(error, ErrorCode.INTERNAL_ERROR, String(error));
    }
    await emitAuthEvent(ctx, ctx.auth.config, {
      kind: "totp.enrolled",
      actor: { type: "user", id: userId },
      subject: { type: "totp", id: totpId },
      targets: [{ kind: "user", id: userId }],
      outcome: "success",
      data: { totpId },
    });
    return { kind: "signedIn" as const, session: signInResult };
  }

  /**
   * `verify` without `totpId`: completes a 2FA challenge during sign-in.
   * Looks up the user's verified TOTP factor, validates the code, signs in.
   */
  async function verifyChallenge(code: string, verifier: string): Promise<TotpResult> {
    let doc;
    try {
      doc = await queryVerifierById(ctx, verifier);
    } catch {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    if (doc === null) {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    const data = parseTotpVerifierData(doc.signature ?? undefined);
    if (typeof data.userId !== "string" || data.userId.length === 0) {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    const userId = data.userId;

    // Reserve (consume) a token up front so concurrent guesses cannot all clear
    // a non-consuming check before any failure commits — this is an action, so
    // each runQuery/runMutation is a separate transaction. Refunded on success.
    if (await reserveSignInAttempt(ctx, userId, ctx.auth.config)) {
      throw convexError(ErrorCode.RATE_LIMITED, "Too many TOTP attempts. Try again later.");
    }

    let totp;
    try {
      totp = await queryTotpVerifiedByUserId(ctx, userId);
    } catch {
      throw convexError(ErrorCode.TOTP_NO_ENROLLMENT, "No verified TOTP enrollment found.");
    }
    if (totp === null) {
      throw convexError(ErrorCode.TOTP_NO_ENROLLMENT, "No verified TOTP enrollment found.");
    }
    const challengeSecret = await decryptTotpSecret(totp.secret);
    if (!verifyTOTPWithGracePeriod(challengeSecret, totp.period, totp.digits, code, 30)) {
      // The reservation above already consumed this attempt's token; do not
      // double-record.
      throw convexError(ErrorCode.TOTP_INVALID_CODE, "Invalid TOTP code.");
    }
    // Atomically consume the verifier BEFORE minting a session so two concurrent
    // challenge completions carrying the same verifier cannot each sign in.
    if ((await consumeVerifierById(ctx, verifier)) === null) {
      throw convexError(ErrorCode.TOTP_INVALID_VERIFIER, "Invalid or expired TOTP verifier.");
    }
    // Only the verifier-consumption winner may refund the reserved attempt.
    await resetSignInRateLimit(ctx, userId, ctx.auth.config);
    let signInResult;
    try {
      await mutateTotpUpdateLastUsed(ctx, totp._id, Date.now());
      signInResult = await callSignIn(ctx, { userId, generateTokens: true });
    } catch (error) {
      throw asConvexError(error, ErrorCode.INTERNAL_ERROR, String(error));
    }
    return { kind: "signedIn" as const, session: signInResult };
  }

  const handler = flowHandlers[dispatch.flow];
  if (!handler) {
    throw convexError(ErrorCode.TOTP_MISSING_FLOW, `Unknown TOTP flow: ${dispatch.flow}`);
  }
  return handler();
};
