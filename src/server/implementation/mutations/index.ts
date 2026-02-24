import { GenericId, Infer, v } from "convex/values";
import { AuthTableName, MutationCtx } from "../types.js";
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
import { ConvexAuthConfig } from "../../index.js";
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

// =============================================================================
// Triggered Context (private to storeImpl)
// =============================================================================

/**
 * All auth table names that can have triggers.
 */
const AUTH_TABLES: AuthTableName[] = [
  "users",
  "authAccounts",
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
];

/**
 * Creates a wrapped mutation context that automatically fires triggers
 * for auth table operations. This is private to storeImpl - all mutation
 * implementations receive the already-wrapped context.
 */
function createTriggeredCtx(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
): MutationCtx {
  const triggers = config.triggers;
  if (!triggers) {
    return ctx;
  }

  const rawDb = ctx.db;

  function detectAuthTable(id: GenericId<any>): AuthTableName | null {
    for (const table of AUTH_TABLES) {
      if (rawDb.normalizeId(table, id) !== null) {
        return table;
      }
    }
    return null;
  }

  // Triggers receive the original ctx (not triggeredDb) intentionally.
  // This prevents infinite loops: if a trigger writes to an auth table,
  // it won't fire another trigger. See docs: "No nested triggers".
  const triggeredDb: MutationCtx["db"] = {
    insert: async (table: any, data: any) => {
      const id = await rawDb.insert(table, data);
      const trigger = (triggers as any)[table]?.onCreate;
      if (trigger) {
        if (trigger.length >= 2) {
          const doc = await rawDb.get(id);
          if (doc) {
            await trigger(ctx, doc);
          }
        } else {
          await trigger(ctx);
        }
      }
      return id;
    },

    patch: async (id: any, updates: any) => {
      const table = detectAuthTable(id);
      const trigger = table ? (triggers as any)[table]?.onUpdate : null;
      if (!trigger) {
        await rawDb.patch(id, updates);
        return;
      }
      const needsOldDoc = trigger.length >= 3;
      const needsNewDoc = trigger.length >= 2;
      const oldDoc = needsOldDoc ? await rawDb.get(id) : null;
      await rawDb.patch(id, updates);
      if (needsNewDoc) {
        const newDoc = await rawDb.get(id);
        if (newDoc) {
          await trigger(ctx, newDoc, oldDoc);
        }
      } else {
        await trigger(ctx);
      }
    },

    replace: async (id: any, replacementData: any) => {
      const table = detectAuthTable(id);
      const trigger = table ? (triggers as any)[table]?.onUpdate : null;
      if (!trigger) {
        await rawDb.replace(id, replacementData);
        return;
      }
      const needsOldDoc = trigger.length >= 3;
      const needsNewDoc = trigger.length >= 2;
      const oldDoc = needsOldDoc ? await rawDb.get(id) : null;
      await rawDb.replace(id, replacementData);
      if (needsNewDoc) {
        const newDoc = await rawDb.get(id);
        if (newDoc) {
          await trigger(ctx, newDoc, oldDoc);
        }
      } else {
        await trigger(ctx);
      }
    },

    delete: async (id: any) => {
      const table = detectAuthTable(id);
      const trigger = table ? (triggers as any)[table]?.onDelete : null;
      const needsDoc = trigger && trigger.length >= 3;
      const doc = needsDoc ? await rawDb.get(id) : null;
      await rawDb.delete(id);
      if (trigger) {
        await trigger(ctx, id, doc);
      }
    },

    get: rawDb.get.bind(rawDb),
    query: rawDb.query.bind(rawDb),
    normalizeId: rawDb.normalizeId.bind(rawDb),
    system: rawDb.system,
  };

  return {
    ...ctx,
    db: triggeredDb,
  };
}

// =============================================================================
// Store Implementation
// =============================================================================

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
  _rawCtx: MutationCtx,
  fnArgs: Infer<typeof storeArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
) => {
  // Wrap context once - all implementations receive triggered ctx
  const ctx = createTriggeredCtx(_rawCtx, config);
  const args = fnArgs.args;
  logWithLevel(LOG_LEVELS.INFO, `\`auth:store\` type: ${args.type}`);
  switch (args.type) {
    case "signIn": {
      return signInImpl(ctx, args, config);
    }
    case "signOut": {
      return signOutImpl(ctx, config);
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
      return modifyAccountImpl(ctx, args, getProviderOrThrow, config);
    }
    case "invalidateSessions": {
      return invalidateSessionsImpl(ctx, args, config);
    }
    default:
      args satisfies never;
  }
};
