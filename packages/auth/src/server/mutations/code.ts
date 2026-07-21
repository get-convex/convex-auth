import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, GenericId, Infer, v } from "convex/values";

import type { Hashed, VerificationCode } from "../../shared/brand";
import { ErrorCode } from "../../shared/codes";
import * as Provider from "../crypto";
import { authDb } from "../db";
import { LOG_LEVELS, log, maybeRedact } from "../log";
import { sha256 } from "../random";
import { getAuthSessionId } from "../session/lifecycle";
import { MutationCtx } from "../types";
import { EmailConfig, PhoneConfig } from "../types";
import { upsertUserAndAccount } from "../user/account";
import { AUTH_STORE_REF } from "./store/refs";

export const vCreateVerificationCodeArgs = v.object({
  accountId: v.optional(v.string()),
  provider: v.string(),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  code: v.string(),
  expirationTime: v.number(),
  allowExtraProviders: v.boolean(),
});

type ReturnType = string;

/**
 * Redact secret-bearing fields (the plaintext verification `code`) from the
 * create-code args before they reach a DEBUG log line, so enabling DEBUG never
 * writes a live OTP/verification code to logs.
 * @internal
 */
export function redactCreateVerificationCodeArgsForLog(
  args: Infer<typeof vCreateVerificationCodeArgs>,
): Infer<typeof vCreateVerificationCodeArgs> {
  return { ...args, code: maybeRedact(args.code) };
}

export async function createVerificationCodeImpl(
  ctx: MutationCtx,
  args: Infer<typeof vCreateVerificationCodeArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<ReturnType> {
  log(
    LOG_LEVELS.DEBUG,
    "createVerificationCodeImpl args:",
    redactCreateVerificationCodeArgsForLog(args),
  );
  const {
    email,
    phone,
    code,
    expirationTime,
    provider: providerId,
    accountId: existingAccountId,
    allowExtraProviders,
  } = args;
  const db = authDb(ctx, config);
  const typedExistingAccountId = existingAccountId as GenericId<"Account"> | undefined;
  const existingAccount =
    typedExistingAccountId !== undefined
      ? ((await db.accounts.get({ id: typedExistingAccountId })) ??
        (() => {
          throw new ConvexError({
            code: ErrorCode.ACCOUNT_NOT_FOUND,
            message: `Expected an account to exist for ID "${typedExistingAccountId}"`,
          });
        })())
      : await db.accounts.get({ provider: providerId, providerAccountId: email ?? phone! });

  const provider = getProviderOrThrow(providerId, allowExtraProviders) as EmailConfig | PhoneConfig;
  const { accountId } = await upsertUserAndAccount(
    ctx,
    await getAuthSessionId(ctx),
    existingAccount !== null ? { existingAccount } : { providerAccountId: email ?? phone! },
    provider.type === "email"
      ? { type: "email", provider, profile: { email: email! } }
      : { type: "phone", provider, profile: { phone: phone! } },
    config,
  );
  await generateUniqueVerificationCode(
    ctx,
    accountId,
    providerId,
    code as VerificationCode,
    expirationTime,
    { email, phone },
    config,
  );
  return email ?? phone!;
}

export const callCreateVerificationCode = async <DataModel extends GenericDataModel>(
  ctx: GenericActionCtx<DataModel>,
  args: Infer<typeof vCreateVerificationCodeArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation(AUTH_STORE_REF, {
    args: {
      type: "createVerificationCode",
      ...args,
    },
  }) as Promise<ReturnType>;
};

async function generateUniqueVerificationCode(
  ctx: MutationCtx,
  accountId: GenericId<"Account">,
  provider: string,
  code: VerificationCode,
  expirationTime: number,
  { email, phone }: { email?: string; phone?: string },
  config: Provider.Config,
) {
  const db = authDb(ctx, config);
  const existingCode = await db.verificationCodes.get({ accountId });
  if (existingCode !== null) {
    await db.verificationCodes.delete(existingCode._id);
  }
  const hashedCode = (await sha256(code)) as Hashed<"VerificationCode">;
  const conflictingCode = await db.verificationCodes.get({ code: hashedCode });
  if (conflictingCode !== null && conflictingCode.accountId !== accountId) {
    throw new ConvexError({
      code: ErrorCode.VERIFICATION_CODE_COLLISION,
      message: "Generated verification code conflicts with another pending sign-in.",
    });
  }
  await db.verificationCodes.create({
    accountId,
    provider,
    code: hashedCode,
    expirationTime,
    emailVerified: email,
    phoneVerified: phone,
  });
}
