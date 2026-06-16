/**
 * Configure {@link Passkey} provider given a {@link PasskeyConfig}.
 *
 * Passkeys (WebAuthn) let your users sign up and sign in with a device-bound
 * or synced credential (Face ID, Touch ID, Windows Hello, a security key, or a
 * password manager) instead of a password.
 *
 * The `Passkey` provider supports the following flows, determined by the
 * `flow` parameter passed to `signIn`:
 *
 * - `"registrationOptions"`: Get options (including a challenge) for creating
 *    a new passkey. Returns the options as `data`.
 * - `"registration"`: Verify a newly created passkey and sign up (or, when a
 *    user is already signed in, add the passkey to their account).
 * - `"authenticationOptions"`: Get options (including a challenge) for signing
 *    in with an existing passkey. Returns the options as `data`.
 * - `"authentication"`: Verify a passkey assertion and sign in.
 *
 * On the client you don't need to drive these flows by hand — use the
 * {@link "@convex-dev/auth/react"!usePasskeyAuth} hook, which wraps
 * `@simplewebauthn/browser` and calls `signIn` for you.
 *
 * ```ts
 * import { Passkey } from "@convex-dev/auth/providers/Passkey";
 * import { convexAuth } from "@convex-dev/auth/server";
 *
 * export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
 *   providers: [Passkey],
 * });
 * ```
 *
 * @module
 */

import {
  ConvexCredentials,
  ConvexCredentialsAuthorizeResult,
} from "@convex-dev/auth/providers/ConvexCredentials";
import {
  GenericActionCtxWithAuthConfig,
  consumePasskeyChallenge,
  createAccount,
  createPasskeyChallenge,
  modifyAccountCredentials,
  retrieveAccount,
} from "@convex-dev/auth/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  decodeClientDataJSON,
  isoBase64URL,
} from "@simplewebauthn/server/helpers";
import {
  DocumentByName,
  GenericDataModel,
  WithoutSystemFields,
} from "convex/server";
import { Value } from "convex/values";

// Passkey challenges are short-lived; the user just has to complete the
// platform prompt.
const DEFAULT_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The Relying Party (your app) configuration for WebAuthn.
 *
 * Every field falls back to an environment variable, so the common case
 * requires no configuration at all.
 */
export interface PasskeyRPConfig {
  /**
   * The Relying Party ID. Must be the registrable domain your app is served
   * from (no scheme, no port, no path), for example `example.com`. A passkey
   * created for `example.com` works on `example.com` and its subdomains.
   *
   * Defaults to `process.env.AUTH_PASSKEY_RP_ID`, or the hostname of the
   * first configured origin.
   */
  id?: string;
  /**
   * A human-readable name for your app, shown by some authenticators.
   *
   * Defaults to `process.env.AUTH_PASSKEY_RP_NAME`, or the RP ID.
   */
  name?: string;
  /**
   * The origin(s) (scheme + host + port) your app is served from, for example
   * `https://example.com`. Pass an array to allow multiple origins.
   *
   * Defaults to `process.env.AUTH_PASSKEY_ORIGIN`, or `process.env.SITE_URL`.
   */
  origin?: string | string[];
}

/**
 * The available options to a {@link Passkey} provider for Convex Auth.
 */
export interface PasskeyConfig<DataModel extends GenericDataModel> {
  /**
   * Uniquely identifies the provider, allowing you to use
   * multiple different {@link Passkey} providers.
   */
  id?: string;
  /**
   * Configure the Relying Party (your app). Optional — by default this is
   * derived from environment variables (see {@link PasskeyRPConfig}).
   */
  rp?: PasskeyRPConfig;
  /**
   * Customize the user information stored when a brand new user signs up with
   * a passkey.
   *
   * Receives the params passed to `signIn` during the "registration" flow and
   * must return fields matching your `users` table. Not called when a passkey
   * is added to an already signed-in user.
   */
  profile?: (
    params: Record<string, Value | undefined>,
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => WithoutSystemFields<DocumentByName<DataModel, "users">>;
  /**
   * Forwarded to `@simplewebauthn/server`'s `generateRegistrationOptions` to
   * control what kind of authenticators are allowed and whether a discoverable
   * (resident) credential is created.
   *
   * Defaults to `{ residentKey: "preferred", userVerification: "preferred" }`,
   * which enables usernameless sign-in where supported.
   */
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  /**
   * Whether user verification (biometric / PIN) is required during
   * verification. Defaults to `false` ("preferred").
   */
  requireUserVerification?: boolean;
  /**
   * How long, in milliseconds, a generated challenge is valid for.
   *
   * Defaults to 5 minutes.
   */
  challengeMaxAgeMs?: number;
}

type StoredCredential = {
  publicKey: string;
  counter: number;
  transports?: string[];
};

/**
 * Passkey (WebAuthn) authentication provider.
 *
 * Public keys are stored in the `authAccounts` table, one row per passkey,
 * keyed by the credential ID. Challenges are stored in the
 * `authPasskeyChallenges` table and are single-use.
 */
export function Passkey<DataModel extends GenericDataModel>(
  config: PasskeyConfig<DataModel> = {},
) {
  const provider = config.id ?? "passkey";
  const challengeMaxAgeMs =
    config.challengeMaxAgeMs ?? DEFAULT_CHALLENGE_MAX_AGE_MS;
  const requireUserVerification = config.requireUserVerification ?? false;
  return ConvexCredentials<DataModel>({
    id: "passkey",
    authorize: async (params, ctx): Promise<ConvexCredentialsAuthorizeResult> => {
      const flow = params.flow as string | undefined;
      const { rpID, rpName, origins } = resolveRP(config.rp);

      switch (flow) {
        case "registrationOptions": {
          const profile = config.profile?.(params, ctx) ?? defaultProfile(params);
          // A user-visible label for the credential. When a brand new user is
          // signing up this is typically their email; when an existing user is
          // adding a passkey it's just a display hint.
          const userName =
            (params.email as string | undefined) ??
            (params.name as string | undefined) ??
            (profile as { email?: string; name?: string }).email ??
            (profile as { name?: string }).name ??
            "passkey";
          const options = await generateRegistrationOptions({
            rpName,
            rpID,
            // The user handle stored by the authenticator.
            userID: crypto.randomUUID(),
            userName,
            userDisplayName:
              (profile as { name?: string }).name ?? userName,
            attestationType: "none",
            authenticatorSelection: config.authenticatorSelection ?? {
              residentKey: "preferred",
              userVerification: "preferred",
            },
          });
          // The mutation captures the signed-in user (if any) so the
          // verification step can link the new passkey to them.
          await createPasskeyChallenge(ctx, {
            challenge: options.challenge,
            type: "registration",
            provider,
            expirationTime: Date.now() + challengeMaxAgeMs,
          });
          return { data: options as unknown as Record<string, Value> };
        }

        case "registration": {
          const response = parseResponse(params.response);
          const challenge = decodeClientDataJSON(
            response.response.clientDataJSON,
          ).challenge;
          const consumed = await consumePasskeyChallenge(ctx, {
            challenge,
            type: "registration",
            provider,
          });
          if (consumed === null) {
            throw new Error("Invalid or expired passkey challenge");
          }
          const verification = await verifyRegistrationResponse({
            response,
            expectedChallenge: challenge,
            expectedOrigin: origins,
            expectedRPID: rpID,
            requireUserVerification,
          });
          if (
            !verification.verified ||
            verification.registrationInfo === undefined
          ) {
            throw new Error("Passkey registration could not be verified");
          }
          const { credentialID, credentialPublicKey, counter } =
            verification.registrationInfo;
          const credentialId = isoBase64URL.fromBuffer(credentialID);
          const secret = serializeCredential({
            publicKey: isoBase64URL.fromBuffer(credentialPublicKey),
            counter,
            transports: response.response?.transports,
          });
          // The user captured when the challenge was issued, if the passkey is
          // being added to an already signed-in user.
          const linkUserId = consumed.userId;
          const profile = config.profile?.(params, ctx) ?? defaultProfile(params);
          const { user } = await createAccount<DataModel>(ctx, {
            provider,
            account: { id: credentialId, secret },
            profile: profile as WithoutSystemFields<
              DocumentByName<DataModel, "users">
            >,
            userId: linkUserId ?? undefined,
          });
          return { userId: user._id };
        }

        case "authenticationOptions": {
          const options = await generateAuthenticationOptions({
            rpID,
            userVerification: requireUserVerification
              ? "required"
              : "preferred",
          });
          await createPasskeyChallenge(ctx, {
            challenge: options.challenge,
            type: "authentication",
            provider,
            expirationTime: Date.now() + challengeMaxAgeMs,
          });
          return { data: options as unknown as Record<string, Value> };
        }

        case "authentication": {
          const response = parseResponse(params.response);
          const challenge = decodeClientDataJSON(
            response.response.clientDataJSON,
          ).challenge;
          const consumed = await consumePasskeyChallenge(ctx, {
            challenge,
            type: "authentication",
            provider,
          });
          if (consumed === null) {
            throw new Error("Invalid or expired passkey challenge");
          }
          const credentialId = response.id as string;
          const retrieved = await retrieveAccount<DataModel>(ctx, {
            provider,
            account: { id: credentialId },
          }).catch(() => null);
          if (retrieved === null) {
            throw new Error("Unknown passkey");
          }
          const stored = deserializeCredential(
            retrieved.account.secret as string | undefined,
          );
          const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: challenge,
            expectedOrigin: origins,
            expectedRPID: rpID,
            requireUserVerification,
            authenticator: {
              credentialID: isoBase64URL.toBuffer(credentialId),
              credentialPublicKey: isoBase64URL.toBuffer(stored.publicKey),
              counter: stored.counter,
              transports: stored.transports as any,
            },
          });
          if (!verification.verified) {
            throw new Error("Passkey authentication could not be verified");
          }
          // Persist the updated signature counter to detect cloned
          // authenticators.
          if (
            verification.authenticationInfo.newCounter !== stored.counter
          ) {
            await modifyAccountCredentials<DataModel>(ctx, {
              provider,
              account: {
                id: credentialId,
                secret: serializeCredential({
                  ...stored,
                  counter: verification.authenticationInfo.newCounter,
                }),
              },
            });
          }
          return { userId: retrieved.user._id };
        }

        default:
          throw new Error(
            "Missing `flow` param for passkey sign-in, it must be one of " +
              '"registrationOptions", "registration", ' +
              '"authenticationOptions" or "authentication". ' +
              "Use the `usePasskeyAuth` hook to drive these automatically.",
          );
      }
    },
    // Public keys aren't secrets to be hashed — store them verbatim so we can
    // read them back during authentication.
    crypto: {
      async hashSecret(secret: string) {
        return secret;
      },
      async verifySecret(secret: string, stored: string) {
        return secret === stored;
      },
    },
    ...config,
  });
}

function resolveRP(rp: PasskeyRPConfig | undefined) {
  const originValue =
    rp?.origin ?? process.env.AUTH_PASSKEY_ORIGIN ?? process.env.SITE_URL;
  if (originValue === undefined || originValue === "") {
    throw new Error(
      "The Passkey provider requires an origin. Set the `rp.origin` option, " +
        "or the `AUTH_PASSKEY_ORIGIN` or `SITE_URL` environment variable.",
    );
  }
  const origins = Array.isArray(originValue) ? originValue : [originValue];
  const rpID =
    rp?.id ?? process.env.AUTH_PASSKEY_RP_ID ?? new URL(origins[0]).hostname;
  const rpName = rp?.name ?? process.env.AUTH_PASSKEY_RP_NAME ?? rpID;
  return { rpID, rpName, origins };
}

function parseResponse(response: Value | undefined): any {
  if (response === undefined || response === null) {
    throw new Error("Missing `response` param for passkey verification");
  }
  return typeof response === "string" ? JSON.parse(response) : response;
}

function serializeCredential(credential: StoredCredential) {
  return JSON.stringify(credential);
}

function deserializeCredential(secret: string | undefined): StoredCredential {
  if (secret === undefined) {
    throw new Error("Passkey account is missing its stored public key");
  }
  return JSON.parse(secret) as StoredCredential;
}

function defaultProfile(params: Record<string, unknown>) {
  return stripUndefined({
    email: params.email as string | undefined,
    name: params.name as string | undefined,
  });
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as T;
}
