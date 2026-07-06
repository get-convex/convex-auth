import { Infer, v } from "convex/values";

import { LOG_LEVELS } from "../log";
import { log } from "../log";
import type { ServerServices } from "../services/resolve";
import { MutationCtx } from "../types";
import { vModifyAccountArgs, modifyAccountImpl } from "./account";
import { vCreateVerificationCodeArgs, createVerificationCodeImpl } from "./code";
import { vCredentialsSignInArgs, credentialsSignInImpl } from "./credentials/signin";
import { vInvalidateSessionsArgs, invalidateSessionsImpl } from "./invalidate";
import { vUserOAuthArgs, userOAuthImpl } from "./oauth";
import { vRefreshSessionArgs, refreshSessionImpl } from "./refresh";
import { vCreateAccountFromCredentialsArgs, createAccountFromCredentialsImpl } from "./register";
import {
  vRetrieveAccountWithCredentialsArgs,
  retrieveAccountWithCredentialsImpl,
} from "./retrieve";
import { vVerifierSignatureArgs, verifierSignatureImpl } from "./signature";
import { vSignInArgs, signInSessionImpl } from "./signin";
import { signOutImpl } from "./signout";
import { vVerifierArgs, verifierImpl } from "./verifier";
import { vVerifyCodeAndSignInArgs, verifyCodeAndSignInImpl } from "./verify";

export const vStoreArgs = v.object({
  args: v.union(
    v.object({
      type: v.literal("signIn"),
      ...vSignInArgs.fields,
    }),
    v.object({
      type: v.literal("signOut"),
    }),
    v.object({
      type: v.literal("refreshSession"),
      ...vRefreshSessionArgs.fields,
    }),
    v.object({
      type: v.literal("verifyCodeAndSignIn"),
      ...vVerifyCodeAndSignInArgs.fields,
    }),
    v.object({
      type: v.literal("verifier"),
      ...vVerifierArgs.fields,
    }),
    v.object({
      type: v.literal("verifierSignature"),
      ...vVerifierSignatureArgs.fields,
    }),
    v.object({
      type: v.literal("userOAuth"),
      ...vUserOAuthArgs.fields,
    }),
    v.object({
      type: v.literal("createVerificationCode"),
      ...vCreateVerificationCodeArgs.fields,
    }),
    v.object({
      type: v.literal("createAccountFromCredentials"),
      ...vCreateAccountFromCredentialsArgs.fields,
    }),
    v.object({
      type: v.literal("retrieveAccountWithCredentials"),
      ...vRetrieveAccountWithCredentialsArgs.fields,
    }),
    v.object({
      type: v.literal("credentialsSignIn"),
      ...vCredentialsSignInArgs.fields,
    }),
    v.object({
      type: v.literal("modifyAccount"),
      ...vModifyAccountArgs.fields,
    }),
    v.object({
      type: v.literal("invalidateSessions"),
      ...vInvalidateSessionsArgs.fields,
    }),
  ),
});

export const storeImpl = async (
  ctx: MutationCtx,
  fnArgs: Infer<typeof vStoreArgs>,
  services: ServerServices,
) => {
  const args = fnArgs.args;
  const config = services.config;
  const getProviderOrThrow = services.providerRegistry.getProviderOrThrow;
  if (args.type !== "refreshSession") {
    log(LOG_LEVELS.DEBUG, `\`auth:store\` type: ${args.type}`);
  }

  const handlers: Record<string, (a: typeof args) => Promise<unknown>> = {
    signIn: (a) =>
      signInSessionImpl(ctx, a as Infer<typeof vSignInArgs> & { type: string }, config),
    signOut: () => signOutImpl(ctx, config),
    refreshSession: (a) =>
      refreshSessionImpl(ctx, a as Infer<typeof vRefreshSessionArgs> & { type: string }, config),
    verifyCodeAndSignIn: (a) =>
      verifyCodeAndSignInImpl(
        ctx,
        a as Infer<typeof vVerifyCodeAndSignInArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    verifier: (a) => verifierImpl(ctx, a as Infer<typeof vVerifierArgs> & { type: string }, config),
    verifierSignature: (a) =>
      verifierSignatureImpl(
        ctx,
        a as Infer<typeof vVerifierSignatureArgs> & { type: string },
        config,
      ),
    userOAuth: (a) =>
      userOAuthImpl(
        ctx,
        a as Infer<typeof vUserOAuthArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    createVerificationCode: (a) =>
      createVerificationCodeImpl(
        ctx,
        a as Infer<typeof vCreateVerificationCodeArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    createAccountFromCredentials: (a) =>
      createAccountFromCredentialsImpl(
        ctx,
        a as Infer<typeof vCreateAccountFromCredentialsArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    retrieveAccountWithCredentials: (a) =>
      retrieveAccountWithCredentialsImpl(
        ctx,
        a as Infer<typeof vRetrieveAccountWithCredentialsArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    credentialsSignIn: (a) =>
      credentialsSignInImpl(
        ctx,
        a as Infer<typeof vCredentialsSignInArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    modifyAccount: (a) =>
      modifyAccountImpl(
        ctx,
        a as Infer<typeof vModifyAccountArgs> & { type: string },
        getProviderOrThrow,
        config,
      ),
    invalidateSessions: (a) =>
      invalidateSessionsImpl(
        ctx,
        a as Infer<typeof vInvalidateSessionsArgs> & { type: string },
        config,
      ),
  };

  const handler = handlers[args.type];
  if (!handler) {
    throw new Error(`Unknown store type: "${args.type}"`);
  }
  return await handler(args);
};
