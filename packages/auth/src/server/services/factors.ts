/**
 * Account / passkey / TOTP unlink helpers for the auth runtime.
 *
 * Each helper removes the component row, emits the matching audit event
 * (`account.unlinked` / `passkey.removed` / `totp.removed`), and returns the
 * affected ids. Extracted from the composition root so `runtime.ts` stays a thin
 * assembler; they are bound onto the `auth` facade there.
 *
 * @internal
 * @module
 */

import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, type GenericId, type Value } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import type { configDefaults } from "../config";
import { emitAuthEvent } from "../events";

const convexError = (data: Record<string, Value>) => new ConvexError(data);

/**
 * Build the factor-unlink helpers bound to a resolved auth `config`.
 *
 * @returns `accountUnlink`, `passkeyDelete`, and `totpDelete`.
 */
export function createFactorUnlinkHelpers(config: ReturnType<typeof configDefaults>) {
  const accountUnlink = async (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { accountId: GenericId<"Account"> },
  ) => {
    const accountDoc = (await ctx.runQuery(config.component.account.get, {
      id: args.accountId,
    })) as { _id: string; userId: string; provider: string } | null;
    if (accountDoc === null) {
      throw convexError({
        code: ErrorCode.ACCOUNT_NOT_FOUND,
        message: "Account not found.",
      });
    }
    await ctx.runMutation(config.component.account.remove, {
      id: args.accountId,
    });
    const userId = accountDoc.userId as GenericId<"User">;
    const provider = accountDoc.provider;
    await emitAuthEvent(ctx, config, {
      kind: "account.unlinked",
      actor: { type: "user", id: userId },
      subject: { type: "account", id: args.accountId },
      targets: [{ kind: "user", id: userId }],
      outcome: "success",
      data: {
        accountId: args.accountId,
        provider,
      },
    });
    return { accountId: args.accountId, userId, provider };
  };

  const passkeyDelete = async (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { passkeyId: GenericId<"Passkey"> },
  ) => {
    const passkeyDoc = (await ctx.runQuery(config.component.factor.passkey.get, {
      id: args.passkeyId,
    })) as { _id: string; userId: string } | null;
    if (passkeyDoc === null) {
      throw convexError({
        code: ErrorCode.PASSKEY_NOT_FOUND,
        message: "Passkey not found.",
      });
    }
    await ctx.runMutation(config.component.factor.passkey.remove, {
      id: args.passkeyId,
    });
    const userId = passkeyDoc.userId as GenericId<"User">;
    await emitAuthEvent(ctx, config, {
      kind: "passkey.removed",
      actor: { type: "user", id: userId },
      subject: { type: "passkey", id: args.passkeyId },
      targets: [{ kind: "user", id: userId }],
      outcome: "success",
      data: { passkeyId: args.passkeyId },
    });
    return { passkeyId: args.passkeyId, userId };
  };

  const totpDelete = async (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { totpId: GenericId<"TotpFactor"> },
  ) => {
    const totpDoc = (await ctx.runQuery(config.component.factor.totp.get, {
      id: args.totpId,
    })) as { _id: string; userId: string } | null;
    if (totpDoc === null) {
      throw convexError({
        code: ErrorCode.TOTP_NOT_FOUND,
        message: "TOTP factor not found.",
      });
    }
    await ctx.runMutation(config.component.factor.totp.remove, {
      id: args.totpId,
    });
    const userId = totpDoc.userId as GenericId<"User">;
    await emitAuthEvent(ctx, config, {
      kind: "totp.removed",
      actor: { type: "user", id: userId },
      subject: { type: "totp", id: args.totpId },
      targets: [{ kind: "user", id: userId }],
      outcome: "success",
      data: { totpId: args.totpId },
    });
    return { totpId: args.totpId, userId };
  };

  return { accountUnlink, passkeyDelete, totpDelete };
}
