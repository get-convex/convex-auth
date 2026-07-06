import { GenericId, ConvexError, type Value } from "convex/values";

import { assertNever } from "../../shared/brand";
import { authFlowError } from "../../shared/errors";
import type {
  AuthTokens,
  SignInFlowResult,
  SignInRedirectResult,
  SignInSessionResult,
  SignInStartResult,
  SignInTotpChallengeResult,
} from "../../shared/results";
import { handleDevice } from "../device";
import type { AuthErrorData } from "../errors";
import { toConvexError } from "../errors";
import { log } from "../log";
import {
  callCreateVerificationCode,
  callRefreshSession,
  callSignIn,
  callVerifier,
  callVerifyCodeAndSignIn,
} from "../mutations/calls";
import { handlePasskey } from "../passkey";
import type { SignInParams } from "../payloads";
import { generateRandomString } from "../random";
import { redirectAbsoluteUrl, setURLSearchParam } from "../redirects";
import { finalizeSessionIssuance } from "../session/lifecycle";
import { handleTotp } from "../totp";
import {
  AuthProviderMaterializedConfig,
  ConvexCredentialsConfig,
  EmailConfig,
  GenericActionCtxWithAuthConfig,
  PhoneConfig,
} from "../types";
import { queryTotpVerifiedByUserId } from "../component/factor/db";
import { AuthDataModel, SessionInfo } from "../types";
import type { OAuthMaterializedConfig } from "../types";
import { authUrlFromEnv } from "../url";
import { withSpan } from "../utils/span";

const DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_S = 60 * 60 * 24;

type EnrichedActionCtx = GenericActionCtxWithAuthConfig<AuthDataModel>;

type SignInResult = SignInFlowResult<SessionInfo<AuthTokens | null> | null>;

type VerificationParams = {
  email?: string;
  phone?: string;
  redirectTo?: unknown;
  connectionId?: unknown;
  loginHint?: unknown;
  protocol?: unknown;
  code?: unknown;
};

const normalizeVerificationParams = (params: SignInParams | undefined) => {
  const value = (params ?? {}) as VerificationParams;
  return {
    email: typeof value.email === "string" ? value.email : undefined,
    phone: typeof value.phone === "string" ? value.phone : undefined,
    redirectTo: value.redirectTo,
    connectionId: value.connectionId,
    loginHint: value.loginHint,
    protocol: value.protocol,
    code: value.code,
  };
};

const describeUnknown = (value: unknown) => {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null
  ) {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json ?? Object.prototype.toString.call(value);
};

const asConvexError = (
  error: unknown,
  code: string,
  message: string,
): ConvexError<AuthErrorData> => {
  if (error instanceof ConvexError) {
    return error;
  }
  if (error instanceof Error) {
    return toConvexError(authFlowError(code, error.message || message));
  }
  return toConvexError(authFlowError(code, `${message} ${describeUnknown(error)}`.trim()));
};

const asCredentialsError = (error: unknown): ConvexError<AuthErrorData> => {
  if (error instanceof ConvexError) {
    return error as ConvexError<AuthErrorData>;
  }
  if (error instanceof Error) {
    return new ConvexError({
      code: error.message.startsWith("Missing `") ? "INVALID_PARAMETERS" : "INVALID_CREDENTIALS",
      message: error.message,
    });
  }
  return toConvexError(authFlowError("INTERNAL_ERROR", "Failed to authorize credentials."));
};

/**
 * Entry point for all sign-in flows.
 *
 * Refreshes a session (when only `refreshToken` is given), verifies a sign-in
 * code (when only `params.code` is given), or dispatches to the matching
 * provider handler based on `provider.type`.
 *
 * @param provider - The resolved provider, or `null` for refresh/code-only calls.
 * @returns The flow result: `signedIn`, `started`, `redirect`, `totpRequired`, etc.
 */
export async function signInImpl(
  ctx: EnrichedActionCtx,
  provider: AuthProviderMaterializedConfig | null,
  args: {
    accountId?: GenericId<"Account">;
    params?: SignInParams;
    verifier?: string;
    refreshToken?: string;
    calledBy?: string;
  },
  options: {
    generateTokens: boolean;
    allowExtraProviders: boolean;
    authSiteUrl?: string;
    resolveConnectionProtocol?: (
      ctx: EnrichedActionCtx,
      connectionId: string,
    ) => Promise<"oidc" | "saml">;
  },
): Promise<SignInResult> {
  return withSpan(
    "convex-auth.signin",
    {
      hasProvider: provider !== null,
      hasCode: args.params?.code !== undefined,
      hasRefreshToken: args.refreshToken !== undefined,
    },
    async () => {
      if (provider === null && args.refreshToken) {
        try {
          const session = await callRefreshSession(ctx, { refreshToken: args.refreshToken! });
          if (session === null) {
            return { kind: "signedIn" as const, session: null };
          }
          return { kind: "signedIn" as const, session };
        } catch (error) {
          throw asConvexError(error, "INTERNAL_ERROR", "Failed to refresh session.");
        }
      }

      if (provider === null && args.params?.code !== undefined) {
        try {
          const result = await callVerifyCodeAndSignIn(ctx, {
            params: args.params as SignInParams,
            verifier: args.verifier,
            generateTokens: true,
            allowExtraProviders: options.allowExtraProviders,
          });
          return { kind: "signedIn" as const, session: result };
        } catch (error) {
          throw asConvexError(error, "INTERNAL_ERROR", "Failed to verify sign-in code.");
        }
      }

      const resolvedProvider = provider;
      if (resolvedProvider === null) {
        throw toConvexError(
          authFlowError(
            "SIGN_IN_MISSING_PARAMS",
            "Cannot sign in: missing provider, code, or refresh token.",
          ),
        );
      }

      /** Exhaustive narrowing dispatch: each case narrows `resolvedProvider` to its concrete config so the handler receives the typed variant without a cast. */
      switch (resolvedProvider.type) {
        case "email":
        case "phone":
          return handleEmailAndPhoneProvider(ctx, resolvedProvider, args, options);
        case "credentials":
          return handleCredentials(ctx, resolvedProvider, args, options);
        case "oauth":
          return handleOAuthProvider(ctx, resolvedProvider, args, options);
        case "passkey":
          return handlePasskey(ctx, resolvedProvider, args);
        case "totp":
          return handleTotp(ctx, resolvedProvider, args);
        case "device":
          return handleDevice(ctx, resolvedProvider, args);
        case "connection":
          return handleConnectionProvider(ctx, args, options);
        default:
          return assertNever(resolvedProvider, "Unknown provider type");
      }
    },
  );
}

async function handleEmailAndPhoneProvider(
  ctx: EnrichedActionCtx,
  provider: EmailConfig | PhoneConfig,
  args: {
    params?: SignInParams;
    accountId?: GenericId<"Account">;
  },
  options: {
    generateTokens: boolean;
    allowExtraProviders: boolean;
  },
): Promise<SignInStartResult | SignInSessionResult<SessionInfo<AuthTokens>>> {
  return withSpan(`convex-auth.signin.${provider.type}`, {}, async () => {
    const normalizedParams = normalizeVerificationParams(args.params);
    if (args.params?.code !== undefined) {
      let result;
      try {
        result = await callVerifyCodeAndSignIn(ctx, {
          params: args.params as SignInParams,
          provider: provider.id,
          generateTokens: options.generateTokens,
          allowExtraProviders: options.allowExtraProviders,
        });
      } catch (error) {
        throw asConvexError(error, "INTERNAL_ERROR", "Failed to verify email or phone code.");
      }
      if (result === null) {
        throw toConvexError(
          authFlowError("INVALID_VERIFICATION_CODE", "Invalid or expired verification code."),
        );
      }
      return {
        kind: "signedIn" as const,
        session: result as SessionInfo<AuthTokens>,
      };
    }

    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let code: string;
    if (provider.generateVerificationToken) {
      try {
        code = await provider.generateVerificationToken();
      } catch {
        throw toConvexError(
          authFlowError("INTERNAL_ERROR", "Failed to generate verification token"),
        );
      }
    } else {
      code = generateRandomString(32, alphabet);
    }

    const expirationTime =
      Date.now() + (provider.maxAge ?? DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_S) * 1000;

    let identifier: string;
    try {
      identifier = await callCreateVerificationCode(ctx, {
        provider: provider.id,
        accountId: args.accountId,
        email: normalizedParams.email,
        phone: normalizedParams.phone,
        code,
        expirationTime,
        allowExtraProviders: options.allowExtraProviders,
      });
    } catch (error) {
      throw asConvexError(error, "INTERNAL_ERROR", "Failed to create verification code.");
    }

    let destination: string;
    try {
      destination = await redirectAbsoluteUrl(
        ctx,
        ctx.auth.config,
        (args.params ?? {}) as { redirectTo: unknown },
      );
    } catch (error) {
      throw asConvexError(error, "INVALID_REDIRECT", "Failed to resolve redirect URL.");
    }

    const verificationArgs = {
      identifier,
      url: setURLSearchParam(destination, "code", code),
      token: code,
      expires: new Date(expirationTime),
    };

    if (provider.type === "email") {
      try {
        await provider.sendVerificationRequest(
          {
            ...verificationArgs,
            provider,
            request: new Request("http://localhost"),
          },
          ctx,
        );
      } catch {
        throw toConvexError(authFlowError("INTERNAL_ERROR", "Failed to send email code"));
      }
    } else {
      try {
        await provider.sendVerificationRequest({ ...verificationArgs, provider }, ctx);
      } catch {
        throw toConvexError(authFlowError("INTERNAL_ERROR", "Failed to send phone code"));
      }
    }

    return { kind: "started" as const };
  });
}

async function handleCredentials(
  ctx: EnrichedActionCtx,
  provider: ConvexCredentialsConfig,
  args: {
    params?: SignInParams;
  },
  options: {
    generateTokens: boolean;
  },
): Promise<SignInSessionResult<SessionInfo<AuthTokens | null> | null> | SignInTotpChallengeResult> {
  return withSpan("convex-auth.signin.credentials", {}, async () => {
    let result;
    try {
      result = await withSpan(
        "convex-auth.signin.credentials.authorize",
        { providerId: provider.id },
        () =>
          provider.authorize(
            (args.params ?? {}) as Partial<Record<string, Value | undefined>>,
            ctx,
          ),
      );
    } catch (error) {
      throw asCredentialsError(error);
    }
    if (result === null) {
      return { kind: "signedIn" as const, session: null };
    }
    if (typeof result === "object" && "kind" in result) {
      /**
       * `authorize` may return any non-signedIn flow result, a superset of this
       * function's declared return; the two share only `totpRequired`, so the
       * pass-through needs one typed assertion to the narrower return type.
       */
      return result as
        | SignInSessionResult<SessionInfo<AuthTokens | null> | null>
        | SignInTotpChallengeResult;
    }

    const hintedHasTotp = result.hasTotp;
    const preIssuedIssuance = result.issuance;

    let hasTotpEnrolled: boolean;
    if (hintedHasTotp === false) {
      hasTotpEnrolled = false;
    } else if (hintedHasTotp === true) {
      hasTotpEnrolled = true;
    } else if (preIssuedIssuance !== undefined && preIssuedIssuance.refreshToken === null) {
      hasTotpEnrolled = true;
    } else {
      try {
        const totpDoc = await withSpan(
          "convex-auth.signin.credentials.totp-check",
          { hinted: hintedHasTotp ?? "unknown" },
          () => queryTotpVerifiedByUserId(ctx, result.userId),
        );
        hasTotpEnrolled = totpDoc !== null;
      } catch (error) {
        throw asConvexError(error, "INTERNAL_ERROR", "Failed to load TOTP enrollment.");
      }
    }

    if (hasTotpEnrolled) {
      if (preIssuedIssuance === undefined) {
        try {
          await withSpan(
            "convex-auth.signin.credentials.issue-session",
            { generateTokens: false, totpStepUp: true },
            () =>
              callSignIn(ctx, {
                userId: result.userId,
                sessionId: result.sessionId,
                generateTokens: false,
              }),
          );
        } catch (error) {
          throw asConvexError(error, "INTERNAL_ERROR", "Failed to start TOTP sign-in.");
        }
      }
      let verifier: string;
      try {
        verifier = await callVerifier(ctx, JSON.stringify({ userId: result.userId }));
      } catch (error) {
        throw asConvexError(error, "INTERNAL_ERROR", "Failed to create verifier.");
      }
      return { kind: "totpRequired" as const, verifier };
    }

    if (preIssuedIssuance !== undefined) {
      try {
        const idsAndTokens = await withSpan(
          "convex-auth.signin.credentials.finalize",
          { generateTokens: options.generateTokens, fromAuthorize: true },
          () =>
            finalizeSessionIssuance(ctx.auth.config, {
              ...preIssuedIssuance,
              refreshToken: options.generateTokens ? preIssuedIssuance.refreshToken : null,
            }),
        );
        return { kind: "signedIn" as const, session: idsAndTokens };
      } catch (error) {
        throw asConvexError(error, "INTERNAL_ERROR", "Failed to finalize sign-in.");
      }
    }

    let idsAndTokens;
    try {
      idsAndTokens = await withSpan(
        "convex-auth.signin.credentials.issue-session",
        { generateTokens: options.generateTokens },
        () =>
          callSignIn(ctx, {
            userId: result.userId,
            sessionId: result.sessionId,
            generateTokens: options.generateTokens,
          }),
      );
    } catch (error) {
      throw asConvexError(error, "INTERNAL_ERROR", "Failed to complete sign-in.");
    }
    return { kind: "signedIn" as const, session: idsAndTokens };
  });
}

async function handleOAuthProvider(
  ctx: EnrichedActionCtx,
  provider: OAuthMaterializedConfig,
  args: {
    params?: SignInParams;
    verifier?: string;
  },
  options: {
    allowExtraProviders: boolean;
    authSiteUrl?: string;
  },
): Promise<SignInSessionResult<SessionInfo<AuthTokens> | null> | SignInRedirectResult> {
  return withSpan(`convex-auth.signin.oauth`, { provider: provider.id }, async () => {
    if (args.params?.code !== undefined) {
      let result;
      try {
        result = await callVerifyCodeAndSignIn(ctx, {
          params: args.params as SignInParams,
          verifier: args.verifier,
          generateTokens: true,
          allowExtraProviders: options.allowExtraProviders,
        });
      } catch (error) {
        throw asConvexError(error, "INTERNAL_ERROR", "Failed to verify OAuth sign-in.");
      }
      return {
        kind: "signedIn" as const,
        session: result as SessionInfo<AuthTokens> | null,
      };
    }

    const authSiteUrl = options.authSiteUrl ?? authUrlFromEnv();
    const redirect = new URL(`${authSiteUrl.replace(/\/$/, "")}/signin/${provider.id}`);
    let verifier: string;
    try {
      verifier = await callVerifier(ctx);
    } catch (error) {
      throw asConvexError(error, "INTERNAL_ERROR", "Failed to create verifier.");
    }
    redirect.searchParams.set("code", verifier);

    if (args.params?.redirectTo !== undefined) {
      if (typeof args.params.redirectTo !== "string") {
        throw toConvexError(
          authFlowError(
            "INVALID_REDIRECT",
            `Expected \`redirectTo\` to be a string, got ${describeUnknown(args.params.redirectTo)}`,
          ),
        );
      }
      redirect.searchParams.set("redirectTo", args.params.redirectTo);
    }

    return {
      kind: "redirect" as const,
      redirect: redirect.toString(),
      verifier,
    };
  });
}

async function handleConnectionProvider(
  ctx: EnrichedActionCtx,
  args: {
    params?: SignInParams;
  },
  options: {
    resolveConnectionProtocol?: (
      ctx: EnrichedActionCtx,
      connectionId: string,
    ) => Promise<"oidc" | "saml">;
    authSiteUrl?: string;
  },
): Promise<{ kind: "redirect"; redirect: string; verifier: string }> {
  return withSpan("convex-auth.signin.connection", {}, async () => {
    const normalizedParams = normalizeVerificationParams(args.params);
    const connectionId = normalizedParams.connectionId;
    if (!connectionId || typeof connectionId !== "string") {
      throw toConvexError(
        authFlowError("SIGN_IN_MISSING_PARAMS", "connectionId is required for Connection sign-in."),
      );
    }

    let protocol: "oidc" | "saml" =
      (normalizedParams.protocol === "oidc" || normalizedParams.protocol === "saml"
        ? normalizedParams.protocol
        : undefined) ??
      (options.resolveConnectionProtocol
        ? await (async () => {
            try {
              return await options.resolveConnectionProtocol!(ctx, connectionId);
            } catch (error) {
              throw asConvexError(
                error,
                "INTERNAL_ERROR",
                "Failed to resolve Connection protocol.",
              );
            }
          })()
        : "oidc");

    log("DEBUG", "[group-connection] signin:resolved", {
      connectionId,
      protocol,
      redirectTo: typeof args.params?.redirectTo === "string" ? args.params.redirectTo : undefined,
    });

    if (protocol !== "oidc" && protocol !== "saml") {
      throw toConvexError(
        authFlowError(
          "SIGN_IN_MISSING_PARAMS",
          `Invalid Connection protocol: ${protocol as string}. Expected "oidc" or "saml".`,
        ),
      );
    }

    let verifier: string;
    try {
      verifier = await callVerifier(ctx);
    } catch (error) {
      throw asConvexError(error, "INTERNAL_ERROR", "Failed to create verifier.");
    }
    const siteUrl = options.authSiteUrl ?? authUrlFromEnv();
    const redirect = new URL(
      `${siteUrl.replace(/\/$/, "")}/connections/${connectionId}/${protocol}/signin`,
    );
    redirect.searchParams.set("code", verifier);

    if (typeof args.params?.redirectTo === "string") {
      redirect.searchParams.set("redirectTo", args.params.redirectTo);
    }
    if (typeof normalizedParams.loginHint === "string") {
      redirect.searchParams.set("loginHint", normalizedParams.loginHint);
    }
    log("DEBUG", "[group-connection] signin:redirect", {
      connectionId,
      protocol,
      redirect: redirect.toString(),
    });

    return {
      kind: "redirect" as const,
      redirect: redirect.toString(),
      verifier,
    };
  });
}
