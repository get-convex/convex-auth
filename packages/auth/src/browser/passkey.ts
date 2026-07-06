import type {
  FactorDeps,
  PasskeyClient,
  PasskeyRegisterOptions,
  PasskeySignInOptions,
} from "../client/core/types";
import { createPasskeyClientCore, type PasskeyCeremony } from "../client/factors/passkey";
import { base64urlDecode, base64urlEncode } from "./runtime";

type ConditionalMediationCredential = typeof PublicKeyCredential & {
  isConditionalMediationAvailable?: () => Promise<boolean>;
};

type PasskeyCredentialDescriptor = {
  type?: string;
  id: string;
  transports?: AuthenticatorTransport[];
};

type PasskeyRegistrationOptions = {
  rp: PublicKeyCredentialRpEntity;
  user: {
    id: string;
    name: string;
    displayName: string;
  };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: PasskeyCredentialDescriptor[];
};

type PasskeyAuthenticationOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: PasskeyCredentialDescriptor[];
};

const browserPasskeyCeremony: PasskeyCeremony = {
  isSupported: (): boolean =>
    typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined",

  isAutofillSupported: async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    if (typeof window.PublicKeyCredential === "undefined") return false;
    const credential = window.PublicKeyCredential as ConditionalMediationCredential;
    if (typeof credential.isConditionalMediationAvailable !== "function") {
      return false;
    }
    return credential.isConditionalMediationAvailable();
  },

  register: async (rawOptions, opts?: PasskeyRegisterOptions) => {
    const options = rawOptions as PasskeyRegistrationOptions;
    const createOptions: CredentialCreationOptions = {
      publicKey: {
        rp: options.rp,
        user: {
          id: base64urlDecode(options.user.id).buffer as ArrayBuffer,
          name: options.user.name,
          displayName: options.user.displayName,
        },
        challenge: base64urlDecode(options.challenge).buffer as ArrayBuffer,
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        attestation: options.attestation,
        authenticatorSelection: options.authenticatorSelection,
        excludeCredentials: (options.excludeCredentials ?? []).map(
          (cred: PasskeyCredentialDescriptor) => ({
            type: (cred.type ?? "public-key") as "public-key",
            id: base64urlDecode(cred.id).buffer as ArrayBuffer,
            transports: cred.transports,
          }),
        ),
      },
    };

    const createAbort = new AbortController();
    createOptions.signal = createAbort.signal;
    const createAbortTimer = setTimeout(
      () => createAbort.abort(new DOMException("Passkey registration timed out", "TimeoutError")),
      options.timeout ?? 120_000,
    );
    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.create(
        createOptions,
      )) as PublicKeyCredential | null;
    } finally {
      clearTimeout(createAbortTimer);
    }
    if (!credential) {
      throw new Error("Passkey registration was cancelled");
    }

    const response = credential.response as AuthenticatorAttestationResponse;
    const transports =
      typeof response.getTransports === "function" ? response.getTransports() : undefined;

    return {
      flow: "verify",
      clientDataJSON: base64urlEncode(response.clientDataJSON),
      attestationObject: base64urlEncode(response.attestationObject),
      transports,
      passkeyName: opts?.name,
      email: opts?.email,
    };
  },

  signIn: async (rawOptions, opts?: PasskeySignInOptions) => {
    const options = rawOptions as PasskeyAuthenticationOptions;
    const getOptions: CredentialRequestOptions = {
      publicKey: {
        challenge: base64urlDecode(options.challenge).buffer as ArrayBuffer,
        timeout: options.timeout,
        rpId: options.rpId,
        userVerification: options.userVerification,
        allowCredentials: (options.allowCredentials ?? []).map(
          (cred: PasskeyCredentialDescriptor) => ({
            type: (cred.type ?? "public-key") as "public-key",
            id: base64urlDecode(cred.id).buffer as ArrayBuffer,
            transports: cred.transports,
          }),
        ),
      },
      ...(opts?.autofill
        ? ({
            mediation: "conditional" as CredentialMediationRequirement,
          } as const)
        : {}),
    };

    const getAbort = new AbortController();
    getOptions.signal = getAbort.signal;
    const getAbortTimer = opts?.autofill
      ? undefined
      : setTimeout(
          () =>
            getAbort.abort(new DOMException("Passkey authentication timed out", "TimeoutError")),
          options.timeout ?? 120_000,
        );
    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.get(getOptions)) as PublicKeyCredential | null;
    } finally {
      if (getAbortTimer !== undefined) clearTimeout(getAbortTimer);
    }
    if (!credential) {
      throw new Error("Passkey authentication was cancelled");
    }

    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      flow: "verify",
      credentialId: base64urlEncode(credential.rawId),
      clientDataJSON: base64urlEncode(response.clientDataJSON),
      authenticatorData: base64urlEncode(response.authenticatorData),
      signature: base64urlEncode(response.signature),
    };
  },
};

/** @internal */
export function createPasskeyClient(deps: FactorDeps): PasskeyClient {
  return createPasskeyClientCore(deps, browserPasskeyCeremony);
}
