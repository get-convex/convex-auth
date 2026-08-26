/// <reference types="vite/client" />
// This helper ships as TypeScript, not as part of the compiled build: the
// `import.meta.glob` below is a Vite macro that only works if the consumer's
// bundler transforms this file. Vitest externalizes plain `.js` under
// `node_modules` and would leave the macro untransformed, but it can't
// externalize `.ts`, so shipping source is what makes this work at all.
// The schema import below uses the extension of the file on disk. The
// TypeScript compiler of the consumer reads this file, thus the consumer must
// set `allowImportingTsExtensions`. If it is not set, TypeScript gives the
// error TS5097.
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { toArrayBuffer } from "../passkey/helpers.ts";
import schema from "../passkey/schema.ts";
import {
  buildAssertion,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  type TestCredential,
} from "../passkey/testAuthenticator.ts";
const modules = import.meta.glob("../passkey/**/*.ts");

/**
 * Register the passkey provider component with a `convex-test` instance.
 *
 * The component erases expired challenges through a nested batch worker, so
 * we register that under `<name>/batchWorker` too. This mirrors how it is
 * mounted when the app `app.use`s the provider's `convex.config`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerPasskeyProvider(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPasskey",
) {
  t.registerComponent(name, schema, modules);
  registerBatchWorker(t, `${name}/batchWorker`);
}

/** One passkey of the software authenticator, with its private key. */
export type { TestCredential };

/** What `navigator.credentials.create()` gives a registration ceremony. */
export interface TestAttestation {
  attestationObject: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
}

/** What `navigator.credentials.get()` gives an authentication ceremony. */
export interface TestAssertion {
  credentialId: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
}

/** A software authenticator that answers the ceremonies of one app. */
export interface TestAuthenticator {
  /**
   * Make a new ES256 credential. The authenticator keeps no state, thus the
   * caller must hold the result to use the passkey again.
   */
  createCredential(): Promise<TestCredential>;
  /** Answer a registration challenge with a new credential. */
  attest(credential: TestCredential, challenge: ArrayBuffer): TestAttestation;
  /** Answer an authentication challenge with an existing credential. */
  assert(
    credential: TestCredential,
    challenge: ArrayBuffer,
  ): Promise<TestAssertion>;
}

/**
 * Make the software authenticator that drives the WebAuthn ceremonies of an
 * app test. It signs with real WebCrypto keys, thus the provider runs its
 * true parsing and signature verification against the bytes.
 *
 * Give it the same `rpId` and `origin` that the app gives
 * `setupUsernamePasskey`. Both values are bound here because a ceremony that
 * names another relying party fails verification with no other hint.
 *
 * @param options - The relying party ID and the origin of the app under test.
 */
export function createTestAuthenticator({
  rpId,
  origin,
}: {
  rpId: string;
  origin: string;
}): TestAuthenticator {
  return {
    createCredential: generateES256Credential,

    attest(credential, challenge) {
      return {
        attestationObject: toArrayBuffer(
          buildAttestationObject(buildAuthenticatorData({ rpId, credential })),
        ),
        clientDataJSON: toArrayBuffer(
          buildClientDataJSON({ type: "webauthn.create", challenge, origin }),
        ),
      };
    },

    assert(credential, challenge) {
      return buildAssertion(credential, challenge, { rpId, origin });
    },
  };
}
export default {
  registerPasskeyProvider,
  createTestAuthenticator,
  schema,
  modules,
};
