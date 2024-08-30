import { GenericId } from "convex/values";
import {
  AuthProviderMaterializedConfig,
  ConvexCredentialsConfig,
  GenericActionCtxWithAuthConfig,
} from "../types.js";
import { AuthDataModel } from "./types.js";
import {
  callCreateVerificationCode,
  callRefreshSession,
  callSignIn,
  callVerifier,
  callVerifyCodeAndSignIn,
} from "./mutations/index.js";
import { alphabet, generateRandomString } from "oslo/crypto";
import { redirectAbsoluteUrl, setURLSearchParam } from "./redirects.js";
import { requireEnv } from "../utils.js";

const DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_S = 60 * 60 * 24; // 24 hours

export async function signInImpl(
  ctx: GenericActionCtxWithAuthConfig<AuthDataModel>,
  provider: AuthProviderMaterializedConfig | null,
  args: {
    accountId?: GenericId<"authAccounts">;
    params?: Record<string, any>;
    verifier?: string;
    refreshToken?: string;
  },
  options: {
    generateTokens: boolean;
    allowExtraProviders: boolean;
  },
) {
  if (provider === null) {
    if (args.refreshToken) {
      const refreshedSession: {
        tokens: { token: string; refreshToken: string };
      } = (await callRefreshSession(ctx, {
        refreshToken: args.refreshToken,
      }))!;
      return { signedIn: refreshedSession };
    } else if (args.params?.code !== undefined) {
      const result = await callVerifyCodeAndSignIn(ctx, {
        params: args.params,
        verifier: args.verifier,
        generateTokens: true,
        allowExtraProviders: options.allowExtraProviders,
      });
      return {
        signedIn: result as {
          tokens: { token: string; refreshToken: string };
        } | null,
      };
    } else {
      throw new Error(
        "Cannot sign in: Missing `provider`, `params.code` or `refreshToken`",
      );
    }
  }
  if (provider.type === "email" || provider.type === "phone") {
    if (args.params?.code !== undefined) {
      const result = await callVerifyCodeAndSignIn(ctx, {
        params: args.params,
        provider: provider.id,
        generateTokens: options.generateTokens,
        allowExtraProviders: options.allowExtraProviders,
      });
      if (result === null) {
        throw new Error("Could not verify code");
      }
      return {
        signedIn: result as {
          userId: GenericId<"users">;
          sessionId: GenericId<"authSessions">;
          tokens: {
            token: string;
            refreshToken: string;
          };
        },
      };
    }

    const code = provider.generateVerificationToken
      ? await provider.generateVerificationToken()
      : generateRandomString(32, alphabet("0-9", "A-Z", "a-z"));
    const expirationTime =
      Date.now() +
      (provider.maxAge ?? DEFAULT_EMAIL_VERIFICATION_CODE_DURATION_S) * 1000;

    const identifier = await callCreateVerificationCode(ctx, {
      provider: provider.id,
      accountId: args.accountId,
      email: args.params?.email,
      phone: args.params?.phone,
      code,
      expirationTime,
      allowExtraProviders: options.allowExtraProviders,
    });
    const destination = await redirectAbsoluteUrl(
      ctx.auth.config,
      (args.params ?? {}) as { redirectTo: unknown },
    );
    const verificationArgs = {
      identifier,
      url: setURLSearchParam(destination, "code", code),
      token: code,
      expires: new Date(expirationTime),
    };
    if (provider.type === "email") {
      await provider.sendVerificationRequest(
        {
          ...verificationArgs,
          provider: {
            ...provider,
            from:
              // Simplifies demo configuration of Resend
              provider.from === "Auth.js <no-reply@authjs.dev>" &&
              provider.id === "resend"
                ? "My App <onboarding@resend.dev>"
                : provider.from,
          },
          request: new Request("http://localhost"), // TODO: Document
          theme: ctx.auth.config.theme,
        },
        // @ts-expect-error Figure out typing for email providers so they can
        // access ctx.
        ctx,
      );
    } else if (provider.type === "phone") {
      await provider.sendVerificationRequest(
        { ...verificationArgs, provider },
        ctx,
      );
    }
    return { started: true };
  } else if (provider.type === "credentials") {
    const result = await (
      provider.authorize as unknown as ConvexCredentialsConfig["authorize"]
    )(args.params ?? {}, ctx);
    if (result === null) {
      return { signedIn: null };
    }
    const idsAndTokens = await callSignIn(ctx, {
      userId: result.userId,
      sessionId: result.sessionId,
      generateTokens: options.generateTokens,
    });
    return {
      signedIn: idsAndTokens as {
        userId: GenericId<"users">;
        sessionId: GenericId<"authSessions">;
        tokens: {
          token: string;
          refreshToken: string;
        };
      },
    };
  } else if (provider.type === "oauth" || provider.type === "oidc") {
    // We have this action because:
    // 1. We remember the current sessionId if any, so we can link accounts
    // 2. The client doesn't need to know the HTTP Actions URL
    //    of the backend (this simplifies using local backend)
    // 3. The client doesn't need to know which provider is of which type,
    //    and hence which provider requires client-side redirect
    // 4. On mobile the client can complete the flow manually
    if (args.params?.code !== undefined) {
      const result = await callVerifyCodeAndSignIn(ctx, {
        params: args.params,
        verifier: args.verifier,
        generateTokens: true,
        allowExtraProviders: options.allowExtraProviders,
      });
      return {
        signedIn: result as {
          tokens: { token: string; refreshToken: string };
        } | null,
      };
    }
    const redirect = new URL(
      requireEnv("CONVEX_SITE_URL") + `/api/auth/signin/${provider.id}`,
    );
    const verifier = await callVerifier(ctx);
    redirect.searchParams.set("code", verifier);
    if (args.params?.redirectTo !== undefined) {
      if (typeof args.params.redirectTo !== "string") {
        throw new Error(
          `Expected \`redirectTo\` to be a string, got ${args.params.redirectTo}`,
        );
      }
      redirect.searchParams.set("redirectTo", args.params.redirectTo);
    }
    return { redirect: redirect.toString(), verifier };
  } else {
    provider satisfies never;
    throw new Error(
      `Provider type ${(provider as any).type} is not supported yet`,
    );
  }
}
