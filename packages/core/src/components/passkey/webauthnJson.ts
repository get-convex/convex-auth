/**
 * Convex validators for the four WebAuthn JSON payloads that cross the
 * wire between the browser and the server.
 *
 * SimpleWebAuthn speaks the `*JSON` dialect of WebAuthn defined by the spec
 * (https://w3c.github.io/webauthn/#dictdef-registrationresponsejson): every
 * byte string travels base64url-encoded, so a ceremony payload is plain
 * JSON. `@simplewebauthn/browser` returns exactly these shapes and
 * `@simplewebauthn/server` accepts exactly these shapes, so the validators
 * here are the only translation layer the component needs.
 *
 * Each validator is paired with two assignability assertions against the
 * SimpleWebAuthn type it mirrors. The pair is deliberate: one direction
 * catches a field the validator is missing, the other catches a field the
 * validator invented. An upstream field addition therefore fails
 * `pnpm typecheck` instead of failing a `returns` validator at runtime.
 *
 * @module
 */
import { Infer, v } from "convex/values";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const publicKeyCredentialType = v.literal("public-key");

const authenticatorTransport = v.union(
  v.literal("ble"),
  v.literal("cable"),
  v.literal("hybrid"),
  v.literal("internal"),
  v.literal("nfc"),
  v.literal("smart-card"),
  v.literal("usb"),
);

/** The transports an authenticator reported, for a later `allowCredentials`. */
export const vAuthenticatorTransports = v.array(authenticatorTransport);

const authenticatorAttachment = v.union(
  v.literal("cross-platform"),
  v.literal("platform"),
);

const userVerificationRequirement = v.union(
  v.literal("discouraged"),
  v.literal("preferred"),
  v.literal("required"),
);

const credentialDescriptor = v.object({
  id: v.string(),
  type: publicKeyCredentialType,
  transports: v.optional(vAuthenticatorTransports),
});

// The client extension outputs are an open-ended dictionary that grows with
// the platform, and nothing here reads them. They are carried verbatim so
// `@simplewebauthn/server` sees the response exactly as the browser built
// it.
const clientExtensionResults = v.any();

// ---------------------------------------------------------------------------
// Browser -> server: ceremony responses
// ---------------------------------------------------------------------------

/** A `navigator.credentials.create()` result, as JSON. */
export const vRegistrationResponse = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    attestationObject: v.string(),
    authenticatorData: v.optional(v.string()),
    transports: v.optional(vAuthenticatorTransports),
    publicKeyAlgorithm: v.optional(v.number()),
    publicKey: v.optional(v.string()),
  }),
  authenticatorAttachment: v.optional(authenticatorAttachment),
  clientExtensionResults,
  type: publicKeyCredentialType,
});

/** A `navigator.credentials.get()` result, as JSON. */
export const vAuthenticationResponse = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    signature: v.string(),
    userHandle: v.optional(v.string()),
  }),
  authenticatorAttachment: v.optional(authenticatorAttachment),
  clientExtensionResults,
  type: publicKeyCredentialType,
});

// ---------------------------------------------------------------------------
// Server -> browser: ceremony options
// ---------------------------------------------------------------------------

/** The argument of `@simplewebauthn/browser`'s `startRegistration()`. */
export const vCreationOptions = v.object({
  rp: v.object({ id: v.optional(v.string()), name: v.string() }),
  user: v.object({
    id: v.string(),
    name: v.string(),
    displayName: v.string(),
  }),
  challenge: v.string(),
  pubKeyCredParams: v.array(
    v.object({ alg: v.number(), type: publicKeyCredentialType }),
  ),
  timeout: v.optional(v.number()),
  excludeCredentials: v.optional(v.array(credentialDescriptor)),
  authenticatorSelection: v.optional(
    v.object({
      authenticatorAttachment: v.optional(authenticatorAttachment),
      requireResidentKey: v.optional(v.boolean()),
      residentKey: v.optional(userVerificationRequirement),
      userVerification: v.optional(userVerificationRequirement),
    }),
  ),
  hints: v.optional(
    v.array(
      v.union(
        v.literal("hybrid"),
        v.literal("security-key"),
        v.literal("client-device"),
      ),
    ),
  ),
  attestation: v.optional(
    v.union(
      v.literal("direct"),
      v.literal("enterprise"),
      v.literal("indirect"),
      v.literal("none"),
    ),
  ),
  attestationFormats: v.optional(
    v.array(
      v.union(
        v.literal("fido-u2f"),
        v.literal("packed"),
        v.literal("android-safetynet"),
        v.literal("android-key"),
        v.literal("tpm"),
        v.literal("apple"),
        v.literal("none"),
      ),
    ),
  ),
  extensions: v.optional(v.any()),
});

/** The argument of `@simplewebauthn/browser`'s `startAuthentication()`. */
export const vRequestOptions = v.object({
  challenge: v.string(),
  timeout: v.optional(v.number()),
  rpId: v.optional(v.string()),
  allowCredentials: v.optional(v.array(credentialDescriptor)),
  userVerification: v.optional(userVerificationRequirement),
  hints: v.optional(
    v.array(
      v.union(
        v.literal("hybrid"),
        v.literal("security-key"),
        v.literal("client-device"),
      ),
    ),
  ),
  extensions: v.optional(v.any()),
});

// ---------------------------------------------------------------------------
// Drift guards
// ---------------------------------------------------------------------------

// `true` only when each type is assignable to the other, so a field that
// one side has and the other lacks resolves to `false`.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * Assert that a validator and the SimpleWebAuthn type it mirrors describe
 * the same object. Both directions are checked, so neither a field the
 * validator lacks nor a field it invented survives a typecheck: on a
 * mismatch the argument below is no longer assignable to `true`.
 */
function assertSameShape<A, B>(_proof: MutuallyAssignable<A, B>): void {}

assertSameShape<Infer<typeof vRegistrationResponse>, RegistrationResponseJSON>(
  true,
);
assertSameShape<
  Infer<typeof vAuthenticationResponse>,
  AuthenticationResponseJSON
>(true);
assertSameShape<
  Infer<typeof vCreationOptions>,
  PublicKeyCredentialCreationOptionsJSON
>(true);
assertSameShape<
  Infer<typeof vRequestOptions>,
  PublicKeyCredentialRequestOptionsJSON
>(true);
