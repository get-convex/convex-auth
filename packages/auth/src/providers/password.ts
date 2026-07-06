/**
 * Configure the password provider for email/password authentication.
 *
 * Five flows, all single-word camelCase:
 *
 * - `signUp` — Create a new account.
 * - `signIn` — Sign in with email + password.
 * - `reset` — Kick off a forgot-password flow (issues an OTP via email).
 * - `verify` — Verify any pending email OTP. With `newPassword`, completes a
 *   `reset` flow and updates the password. Without `newPassword`, completes
 *   the post-signup email confirmation. The OTP scope is enforced server-side
 *   by the issuing email provider.
 * - `change` — Authenticated password change (requires `currentPassword`).
 *
 * ```ts
 * import { password } from "@robelest/convex-auth/providers";
 *
 * password()
 * password({ verify: myEmailProvider, reset: myEmailProvider })
 * ```
 *
 * @module
 */

import { scryptAsync } from "@noble/hashes/scrypt.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DocumentByName, GenericDataModel, WithoutSystemFields } from "convex/server";
import { ConvexError, Value } from "convex/values";

import { emitAuthEvent } from "../server/events";
import { getAuthenticatedUserIdOrNull } from "../server/identity/claims";
import { callCredentialsSignIn } from "../server/mutations/calls";
import type { Hashed } from "../shared/brand";
import { ErrorCode } from "../shared/codes";
import type {
  EmailConfig,
  GenericActionCtxWithAuthConfig,
  GenericDoc,
  ConvexCredentialsConfig,
} from "../server/types";
import { credentials, type CredentialsConfig } from "./credentials";

/** Configuration for the {@link password} provider. */
export interface PasswordConfig<DataModel extends GenericDataModel> {
  /**
   * Uniquely identifies the provider, allowing multiple password providers.
   */
  id?: string;
  /**
   * Perform checks on provided params and customize the user information
   * stored after sign up, including email normalization.
   *
   * Called for every flow.
   */
  profile?: (
    params: Record<string, Value | undefined>,
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => WithoutSystemFields<DocumentByName<DataModel, "User">> & {
    email: string;
  };
  /**
   * Performs custom validation on a password during `signUp`, `verify`
   * (when `newPassword` is set), and `change`.
   *
   * Default: non-empty, length >= 8.
   *
   * Throw an `Error` to reject the password.
   */
  validatePasswordRequirements?: (password: string) => void;
  /**
   * Hashing and verification functions. Defaults to scrypt.
   */
  crypto?: CredentialsConfig["crypto"];
  /**
   * Email provider for the `reset` flow. Issues OTPs that the `verify` flow
   * accepts when `newPassword` is included.
   */
  reset?: EmailConfig | PasswordEmailProviderFactory;
  /**
   * Email provider for post-signup email confirmation. Issues OTPs that the
   * `verify` flow accepts when `newPassword` is omitted.
   */
  verify?: EmailConfig | PasswordEmailProviderFactory;
}

const PASSWORD_FLOWS = ["signUp", "signIn", "reset", "verify", "change"] as const;
type PasswordFlow = (typeof PASSWORD_FLOWS)[number];

type PasswordFlowDispatch = { tag: PasswordFlow } | { tag: "invalid"; flow: unknown };

type PasswordEmailProviderFactory = () => EmailConfig;

function decodePasswordFlow(flow: unknown): PasswordFlowDispatch {
  if (typeof flow === "string" && (PASSWORD_FLOWS as readonly string[]).includes(flow)) {
    return { tag: flow as PasswordFlow };
  }
  return { tag: "invalid", flow };
}

/**
 * Email and password authentication provider.
 *
 * Passwords are hashed with scrypt by default. Customize via `crypto`.
 *
 * Email verification is opt-in via the `verify` option. Password reset is
 * opt-in via the `reset` option (typically the same email provider).
 *
 * @example
 * ```ts
 * password()
 * password({ verify: myEmailProvider, reset: myEmailProvider })
 * ```
 *
 * @typeParam DataModel - The Convex data model used by the auth context.
 * @param config - Password flow hooks and optional verification providers.
 * @returns A configured password provider for `defineAuth`.
 */
export function password<DataModel extends GenericDataModel = GenericDataModel>(
  config: PasswordConfig<DataModel> = {} as PasswordConfig<DataModel>,
): ConvexCredentialsConfig {
  const provider = config.id ?? "password";
  const resetProvider = typeof config.reset === "function" ? config.reset() : config.reset;
  const verifyProvider = typeof config.verify === "function" ? config.verify() : config.verify;

  return credentials<DataModel>({
    id: provider,
    authorize: async (params, ctx) => {
      const flowDispatch = decodePasswordFlow(params.flow);

      const validatePasswordRequirements = (password: string) => {
        if (config.validatePasswordRequirements !== undefined) {
          config.validatePasswordRequirements(password);
          return;
        }
        validateDefaultPasswordRequirements(password);
      };

      const profile = config.profile?.(params, ctx) ?? defaultProfile(params);
      const { email } = profile;

      const requireStringParam = (value: unknown, name: string, flow: PasswordFlow) => {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(`Missing \`${name}\` param for \`${flow}\` flow`);
        }
        return value;
      };

      const finalizeCredentialsResult = async (
        account: GenericDoc<DataModel, "Account">,
        user: GenericDoc<DataModel, "User">,
      ) => {
        if (verifyProvider && !account.emailVerified) {
          return await ctx.auth.provider.signIn(ctx, verifyProvider, {
            accountId: account._id,
            params,
          });
        }
        return { userId: user._id, hasTotp: false };
      };

      const flowHandlers: Record<
        PasswordFlow,
        () => Promise<Awaited<ReturnType<CredentialsConfig<DataModel>["authorize"]>>>
      > = {
        signUp: async () => {
          const secret = requireStringParam(params.password, "password", "signUp");
          validatePasswordRequirements(secret);
          const created = await ctx.auth.account.create(ctx, {
            provider,
            account: { id: email, secret },
            profile,
            shouldLinkViaEmail: config.verify !== undefined,
            shouldLinkViaPhone: false,
          });
          return await finalizeCredentialsResult(created.account, created.user);
        },

        signIn: async () => {
          const secret = requireStringParam(params.password, "password", "signIn");
          const result = await callCredentialsSignIn(ctx, {
            provider,
            account: { id: email, secret },
            generateTokens: true,
            requireVerifiedEmail: verifyProvider !== undefined,
            enforceTotp: true,
          });
          if (result.kind === "invalidAccount" || result.kind === "invalidSecret") {
            throw new ConvexError({
              code: ErrorCode.INVALID_CREDENTIALS,
              message: "Invalid credentials",
            });
          }
          if (result.kind === "tooManyAttempts") {
            throw new ConvexError({
              code: ErrorCode.RATE_LIMITED,
              message: "Too many failed sign-in attempts. Please try again later.",
            });
          }
          if (result.kind === "emailVerificationRequired") {
            return await ctx.auth.provider.signIn(ctx, verifyProvider!, {
              accountId: result.account._id as GenericDoc<DataModel, "Account">["_id"],
              params,
            });
          }
          const hasTotp = result.kind === "signedIn" ? result.user.hasTotp : true;
          return {
            userId: result.user._id as GenericDoc<DataModel, "User">["_id"],
            hasTotp,
            issuance: result.issuance,
          };
        },

        reset: async () => {
          if (!resetProvider) {
            throw new Error(`Password reset is not enabled for ${provider}`);
          }
          const result = await ctx.auth.account.get(ctx, {
            provider,
            account: { id: email },
          });
          if (result === null) {
            return { kind: "started" as const };
          }
          return await ctx.auth.provider.signIn(ctx, resetProvider, {
            accountId: result.account._id,
            params,
          });
        },

        verify: async () => {
          const newPassword = params.newPassword;
          const isResetCompletion = typeof newPassword === "string" && newPassword.length > 0;

          if (isResetCompletion) {
            if (!resetProvider) {
              throw new Error(`Password reset is not enabled for ${provider}`);
            }
            validatePasswordRequirements(newPassword as string);
            const result = await ctx.auth.provider.signIn(ctx, resetProvider, { params });
            if (result === null) {
              throw new ConvexError({
                code: ErrorCode.INVALID_CREDENTIALS,
                message: "Invalid code",
              });
            }
            if ("kind" in result) {
              throw new ConvexError({
                code: ErrorCode.INVALID_CREDENTIALS,
                message: "Invalid code",
              });
            }
            const { userId, sessionId } = result;
            await ctx.auth.account.update(ctx, {
              provider,
              account: { id: email, secret: newPassword as string },
            });
            await ctx.auth.session.revoke(ctx, {
              userId,
              except: [sessionId],
            });
            await emitAuthEvent(ctx, ctx.auth.config, {
              kind: "password.changed",
              actor: { type: "user", id: userId },
              subject: { type: "user", id: userId },
              targets: [{ kind: "user", id: userId }],
              outcome: "success",
              data: { flow: "reset" },
            });
            return { userId, sessionId };
          }

          if (!verifyProvider) {
            throw new Error(`Email verification is not enabled for ${provider}`);
          }
          const result = await ctx.auth.account.get(ctx, {
            provider,
            account: { id: email },
          });
          if (result === null) {
            return { kind: "started" as const };
          }
          return await ctx.auth.provider.signIn(ctx, verifyProvider, {
            accountId: result.account._id,
            params,
          });
        },

        change: async () => {
          const authedUserId = await getAuthenticatedUserIdOrNull(ctx);
          if (authedUserId === null) {
            throw new ConvexError({
              code: ErrorCode.NOT_SIGNED_IN,
              message: "Sign in first to change your password.",
            });
          }
          const currentPassword = requireStringParam(
            params.currentPassword,
            "currentPassword",
            "change",
          );
          const newPassword = requireStringParam(params.newPassword, "newPassword", "change");
          validatePasswordRequirements(newPassword);

          const result = await callCredentialsSignIn(ctx, {
            provider,
            account: { id: email, secret: currentPassword },
            generateTokens: true,
            requireVerifiedEmail: false,
            enforceTotp: false,
          });
          if (result.kind === "invalidAccount" || result.kind === "invalidSecret") {
            throw new ConvexError({
              code: ErrorCode.INVALID_CREDENTIALS,
              message: "Invalid current password",
            });
          }
          if (result.kind === "tooManyAttempts") {
            throw new ConvexError({
              code: ErrorCode.RATE_LIMITED,
              message: "Too many failed attempts. Please try again later.",
            });
          }
          if (result.kind !== "signedIn") {
            throw new Error(`Unexpected sign-in result: ${result.kind}`);
          }
          const verifiedUserId = result.user._id as GenericDoc<DataModel, "User">["_id"];
          if (verifiedUserId !== authedUserId) {
            throw new Error("Email does not match authenticated user");
          }
          await ctx.auth.account.update(ctx, {
            provider,
            account: { id: email, secret: newPassword },
          });
          await ctx.auth.session.revoke(ctx, {
            userId: verifiedUserId,
            except: [result.issuance.sessionId],
          });
          await emitAuthEvent(ctx, ctx.auth.config, {
            kind: "password.changed",
            actor: { type: "user", id: verifiedUserId },
            subject: { type: "user", id: verifiedUserId },
            targets: [{ kind: "user", id: verifiedUserId }],
            outcome: "success",
            data: { flow: "change" },
          });
          return {
            userId: verifiedUserId,
            hasTotp: false,
            issuance: result.issuance,
          };
        },
      };

      if (flowDispatch.tag === "invalid") {
        throw new Error(
          "Missing or invalid `flow` param. Expected one of: " + PASSWORD_FLOWS.join(", ") + ".",
        );
      }
      return await flowHandlers[flowDispatch.tag]();
    },
    crypto: config.crypto ?? {
      async hashSecret(password: string) {
        return await hashPassword(password);
      },
      async verifySecret(password: string, hash: Hashed<"Password">) {
        return await verifyPassword(password, hash);
      },
    },
    extraProviders: [resetProvider, verifyProvider],
    ...config,
  });
}

function validateDefaultPasswordRequirements(password: string) {
  if (!password || password.length < 8) {
    throw new Error("Invalid password");
  }
}

function defaultProfile(params: Record<string, unknown>) {
  const email = params.email;
  if (typeof email !== "string" || email.trim().length === 0) {
    throw new Error("Missing `email` param");
  }
  return {
    email,
  };
}

const PASSWORD_HASH_PARAMS = {
  N: 16384,
  r: 16,
  p: 1,
  dkLen: 64,
} as const;

const PASSWORD_HASH_PREFIX = `scrypt:N=${PASSWORD_HASH_PARAMS.N},r=${PASSWORD_HASH_PARAMS.r},p=${PASSWORD_HASH_PARAMS.p},dkLen=${PASSWORD_HASH_PARAMS.dkLen}`;

async function hashPassword(password: string): Promise<Hashed<"Password">> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const hash = await scryptAsync(password, salt, PASSWORD_HASH_PARAMS);
  return `${PASSWORD_HASH_PREFIX}$${bytesToHex(salt)}$${bytesToHex(hash)}` as Hashed<"Password">;
}

async function verifyPassword(password: string, storedHash: Hashed<"Password">) {
  const [prefix, saltHex, hashHex] = storedHash.split("$");
  if (prefix !== PASSWORD_HASH_PREFIX || saltHex === undefined || hashHex === undefined) {
    return false;
  }

  let salt: Uint8Array;
  let expectedHash: Uint8Array;
  try {
    salt = hexToBytes(saltHex);
    expectedHash = hexToBytes(hashHex);
  } catch {
    return false;
  }
  if (salt.length !== 32 || expectedHash.length !== PASSWORD_HASH_PARAMS.dkLen) {
    return false;
  }

  const actualHash = await scryptAsync(password, salt, PASSWORD_HASH_PARAMS);
  return constantTimeEqual(actualHash, expectedHash);
}

function hexToBytes(hex: string) {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid password hash");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const start = i * 2;
    const value = Number.parseInt(hex.slice(start, start + 2), 16);
    if (Number.isNaN(value)) {
      throw new Error("Invalid password hash");
    }
    bytes[i] = value;
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
