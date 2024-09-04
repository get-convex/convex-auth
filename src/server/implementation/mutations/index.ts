import { Infer, v } from "convex/values";
import { MutationCtx } from "../types.js";
import { signInArgs, signInImpl } from "./signIn.js";
import { signOutImpl } from "./signOut.js";
import { refreshSessionArgs, refreshSessionImpl } from "./refreshSession.js";
import {
  verifyCodeAndSignInArgs,
  verifyCodeAndSignInImpl,
} from "./verifyCodeAndSignIn.js";
import {
  verifierSignatureArgs,
  verifierSignatureImpl,
} from "./verifierSignature.js";
import { userOAuthArgs, userOAuthImpl } from "./userOAuth.js";
import {
  createVerificationCodeArgs,
  createVerificationCodeImpl,
} from "./createVerificationCode.js";
import {
  createAccountFromCredentialsArgs,
  createAccountFromCredentialsImpl,
} from "./createAccountFromCredentials.js";
import {
  retrieveAccountWithCredentialsArgs,
  retrieveAccountWithCredentialsImpl,
} from "./retrieveAccountWithCredentials.js";
import { modifyAccountArgs, modifyAccountImpl } from "./modifyAccount.js";
import {
  invalidateSessionsArgs,
  invalidateSessionsImpl,
} from "./invalidateSessions.js";
import * as Provider from "../provider.js";
import { verifierImpl } from "./verifier.js";
import { LOG_LEVELS, logWithLevel } from "../utils.js";
export { callInvalidateSessions } from "./invalidateSessions.js";
export { callModifyAccount } from "./modifyAccount.js";
export { callRetreiveAccountWithCredentials } from "./retrieveAccountWithCredentials.js";
export { callCreateAccountFromCredentials } from "./createAccountFromCredentials.js";
export { callCreateVerificationCode } from "./createVerificationCode.js";
export { callUserOAuth } from "./userOAuth.js";
export { callVerifierSignature } from "./verifierSignature.js";
export { callVerifyCodeAndSignIn } from "./verifyCodeAndSignIn.js";
export { callVerifier } from "./verifier.js";
export { callRefreshSession } from "./refreshSession.js";
export { callSignOut } from "./signOut.js";
export { callSignIn } from "./signIn.js";

export const storeArgs = v.object({
  args: v.union(
    v.object({
      type: v.literal("signIn"),
      ...signInArgs.fields,
    }),
    v.object({
      type: v.literal("signOut"),
    }),
    v.object({
      type: v.literal("refreshSession"),
      ...refreshSessionArgs.fields,
    }),
    v.object({
      type: v.literal("verifyCodeAndSignIn"),
      ...verifyCodeAndSignInArgs.fields,
    }),
    v.object({
      type: v.literal("verifier"),
    }),
    v.object({
      type: v.literal("verifierSignature"),
      ...verifierSignatureArgs.fields,
    }),
    v.object({
      type: v.literal("userOAuth"),
      ...userOAuthArgs.fields,
    }),
    v.object({
      type: v.literal("createVerificationCode"),
      ...createVerificationCodeArgs.fields,
    }),
    v.object({
      type: v.literal("createAccountFromCredentials"),
      ...createAccountFromCredentialsArgs.fields,
    }),
    v.object({
      type: v.literal("retrieveAccountWithCredentials"),
      ...retrieveAccountWithCredentialsArgs.fields,
    }),
    v.object({
      type: v.literal("modifyAccount"),
      ...modifyAccountArgs.fields,
    }),
    v.object({
      type: v.literal("invalidateSessions"),
      ...invalidateSessionsArgs.fields,
    }),
  ),
});

export const storeImpl = async (
  ctx: MutationCtx,
  fnArgs: Infer<typeof storeArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
) => {
  const args = fnArgs.args;
  logWithLevel(LOG_LEVELS.INFO, `\`auth:store\` type: ${args.type}`);
  switch (args.type) {
    case "signIn": {
      return signInImpl(ctx, args, config);
    }
    case "signOut": {
      return signOutImpl(ctx);
    }
    case "refreshSession": {
      return refreshSessionImpl(ctx, args, getProviderOrThrow, config);
    }
    case "verifyCodeAndSignIn": {
      return verifyCodeAndSignInImpl(ctx, args, getProviderOrThrow, config);
    }
    case "verifier": {
      return verifierImpl(ctx);
    }
    case "verifierSignature": {
      return verifierSignatureImpl(ctx, args);
    }
    case "userOAuth": {
      return userOAuthImpl(ctx, args, getProviderOrThrow, config);
    }
    case "createVerificationCode": {
      return createVerificationCodeImpl(ctx, args, getProviderOrThrow, config);
    }
    case "createAccountFromCredentials": {
      return createAccountFromCredentialsImpl(
        ctx,
        args,
        getProviderOrThrow,
        config,
      );
    }
    case "retrieveAccountWithCredentials": {
      return retrieveAccountWithCredentialsImpl(
        ctx,
        args,
        getProviderOrThrow,
        config,
      );
    }
    case "modifyAccount": {
      return modifyAccountImpl(ctx, args, getProviderOrThrow);
    }
    case "invalidateSessions": {
      return invalidateSessionsImpl(ctx, args);
    }
    default:
      args satisfies never;
  }
};
