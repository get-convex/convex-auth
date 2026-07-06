import { Passkey, type PasskeyCreateRequest, type PasskeyGetRequest } from "react-native-passkey";

import type { FactorDeps, PasskeyClient, PasskeyRegisterOptions } from "../client/core/types";
import { createPasskeyClientCore, type PasskeyCeremony } from "../client/factors/passkey";

type PasskeyCredentialDescriptor = {
  type?: string;
  id: string;
  transports?: string[];
};

type PasskeyRegistrationOptions = {
  rp: {
    id?: string;
    name: string;
  };
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  attestation?: "none" | "indirect" | "direct" | "enterprise";
  authenticatorSelection?: {
    authenticatorAttachment?: "platform" | "cross-platform";
    requireResidentKey?: boolean;
    residentKey?: "discouraged" | "preferred" | "required";
    userVerification?: "discouraged" | "preferred" | "required";
  };
  excludeCredentials?: PasskeyCredentialDescriptor[];
};

type PasskeyAuthenticationOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: "discouraged" | "preferred" | "required";
  allowCredentials?: PasskeyCredentialDescriptor[];
};

type NativePasskeyCredentialDescriptor = NonNullable<
  PasskeyCreateRequest["excludeCredentials"]
>[number];
type NativeAuthenticatorTransport = NonNullable<
  NativePasskeyCredentialDescriptor["transports"]
>[number];

function requireStringOption(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Server did not return required passkey option \`${name}\``);
  }
  return value;
}

function toPublicKeyCredentialDescriptors(
  credentials: PasskeyCredentialDescriptor[] | undefined,
): NativePasskeyCredentialDescriptor[] {
  return (credentials ?? []).map((cred) => ({
    type: (cred.type ?? "public-key") as "public-key",
    id: cred.id,
    ...(cred.transports === undefined
      ? null
      : { transports: cred.transports as NativeAuthenticatorTransport[] }),
  }));
}

function wrapNativePasskeyError(e: unknown, cancelMessage: string): Error {
  if (e instanceof Error) {
    if (e.message.includes("cancel") || e.message.includes("Cancel")) {
      return new Error(cancelMessage);
    }
    return e;
  }
  const message =
    typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
  if (message.includes("cancel") || message.includes("Cancel")) {
    return new Error(cancelMessage);
  }
  return new Error(message);
}

const expoPasskeyCeremony: PasskeyCeremony = {
  isSupported: () => Passkey.isSupported(),
  isAutofillSupported: async () => false,

  register: async (rawOptions, opts?: PasskeyRegisterOptions) => {
    const options = rawOptions as PasskeyRegistrationOptions;
    const createRequest: PasskeyCreateRequest = {
      challenge: options.challenge,
      rp: { ...options.rp, id: requireStringOption(options.rp.id, "rp.id") },
      user: options.user,
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: toPublicKeyCredentialDescriptors(options.excludeCredentials),
    };

    let credential;
    try {
      credential = await Passkey.create(createRequest);
    } catch (e) {
      throw wrapNativePasskeyError(e, "Passkey registration was cancelled");
    }

    return {
      flow: "verify",
      clientDataJSON: credential.response.clientDataJSON,
      attestationObject: credential.response.attestationObject,
      transports: credential.response.transports,
      passkeyName: opts?.name,
      email: opts?.email,
    };
  },

  signIn: async (rawOptions) => {
    const options = rawOptions as PasskeyAuthenticationOptions;
    const getRequest: PasskeyGetRequest = {
      challenge: options.challenge,
      timeout: options.timeout,
      rpId: requireStringOption(options.rpId, "rpId"),
      userVerification: options.userVerification,
      allowCredentials: toPublicKeyCredentialDescriptors(options.allowCredentials),
    };

    let credential;
    try {
      credential = await Passkey.get(getRequest);
    } catch (e) {
      throw wrapNativePasskeyError(e, "Passkey authentication was cancelled");
    }

    return {
      flow: "verify",
      credentialId: credential.rawId ?? credential.id,
      clientDataJSON: credential.response.clientDataJSON,
      authenticatorData: credential.response.authenticatorData,
      signature: credential.response.signature,
    };
  },
};

/** @internal */
export function createExpoPasskeyClient(deps: FactorDeps): PasskeyClient {
  return createPasskeyClientCore(deps, expoPasskeyCeremony);
}
