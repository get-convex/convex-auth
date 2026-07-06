/**
 * Shared type definitions for the SAML module.
 */

import type { LoginResponseTemplate } from "./template";

export type BinaryLike = string | Uint8Array;
export type MetadataFile = BinaryLike;

/** Inbound HTTP request carrying a SAML message (redirect query or POST body). */
export interface SamlHttpRequest {
  query?: Record<string, string | undefined>;
  body?: Record<string, string | undefined>;
  octetString?: string;
}

/** Result of building a SAML message: the encoded payload and its generated ID. */
export interface BindingContext {
  context: string;
  id: string;
}

/** {@link BindingContext} extended with the endpoint and form fields a POST binding needs. */
export interface PostBindingContext extends BindingContext {
  relayState?: string;
  entityEndpoint: string;
  type: string;
}

type SSOService = {
  isDefault?: boolean;
  Binding: string;
  Location: string;
};

/** Options for generating IdP metadata when no metadata document is supplied. */
export interface MetadataIdpOptions {
  entityID?: string;
  signingCert?: BinaryLike | BinaryLike[];
  encryptCert?: BinaryLike | BinaryLike[];
  wantAuthnRequestsSigned?: boolean;
  nameIDFormat?: string[];
  singleSignOnService?: SSOService[];
  singleLogoutService?: SSOService[];
  requestSignatureAlgorithm?: string;
}

/** Either generation options or a raw IdP metadata document. */
export type MetadataIdpConstructor = MetadataIdpOptions | MetadataFile;

/** Options for generating SP metadata when no metadata document is supplied. */
export interface MetadataSpOptions {
  entityID?: string;
  signingCert?: BinaryLike | BinaryLike[];
  encryptCert?: BinaryLike | BinaryLike[];
  authnRequestsSigned?: boolean;
  wantAssertionsSigned?: boolean;
  wantMessageSigned?: boolean;
  signatureConfig?: SignatureConfig;
  nameIDFormat?: string[];
  singleSignOnService?: SSOService[];
  singleLogoutService?: SSOService[];
  assertionConsumerService?: SSOService[];
  elementsOrder?: string[];
}

/** Either generation options or a raw SP metadata document. */
export type MetadataSpConstructor = MetadataSpOptions | MetadataFile;

/** Controls the XML-dsig prefix and where the signature element is inserted. */
export interface SignatureConfig {
  prefix?: string;
  location?: {
    reference?: string;
    action?: "append" | "prepend" | "before" | "after";
  };
}

/** A raw XML template string with `{tag}` placeholders to be replaced. */
export interface SAMLDocumentTemplate {
  context?: string;
}

/** Full configuration accepted by {@link createServiceProvider}. */
export type ServiceProviderSettings = {
  metadata?: BinaryLike;
  entityID?: string;
  authnRequestsSigned?: boolean;
  wantAssertionsSigned?: boolean;
  wantMessageSigned?: boolean;
  wantLogoutResponseSigned?: boolean;
  wantLogoutRequestSigned?: boolean;
  privateKey?: BinaryLike;
  privateKeyPass?: string;
  isAssertionEncrypted?: boolean;
  requestSignatureAlgorithm?: string;
  encPrivateKey?: BinaryLike;
  encPrivateKeyPass?: BinaryLike;
  assertionConsumerService?: SSOService[];
  singleLogoutService?: SSOService[];
  signatureConfig?: SignatureConfig;
  loginRequestTemplate?: SAMLDocumentTemplate;
  logoutRequestTemplate?: SAMLDocumentTemplate;
  signingCert?: BinaryLike | BinaryLike[];
  encryptCert?: BinaryLike | BinaryLike[];
  transformationAlgorithms?: string[];
  nameIDFormat?: string[];
  allowCreate?: boolean;
  relayState?: string;
  clockDrifts?: [number, number];
};

/** Full configuration accepted by {@link createIdentityProvider}. */
export type IdentityProviderSettings = {
  metadata?: BinaryLike;
  requestSignatureAlgorithm?: string;
  loginResponseTemplate?: LoginResponseTemplate;
  logoutRequestTemplate?: SAMLDocumentTemplate;
  generateID?: () => string;
  entityID?: string;
  privateKey?: BinaryLike;
  privateKeyPass?: string;
  signingCert?: BinaryLike | BinaryLike[];
  encryptCert?: BinaryLike | BinaryLike[];
  nameIDFormat?: string[];
  singleSignOnService?: SSOService[];
  singleLogoutService?: SSOService[];
  isAssertionEncrypted?: boolean;
  encPrivateKey?: BinaryLike;
  encPrivateKeyPass?: string;
  messageSigningOrder?: string;
  wantLogoutRequestSigned?: boolean;
  wantLogoutResponseSigned?: boolean;
  wantAuthnRequestsSigned?: boolean;
  wantLogoutRequestSignedResponseSigned?: boolean;
  tagPrefix?: { [key: string]: string };
};

/** Runtime defaults merged into every entity by {@link DEFAULT_ENTITY_SETTINGS}. */
export interface EntityDefaults {
  dataEncryptionAlgorithm?: string;
  keyEncryptionAlgorithm?: string;
}

/** Merged SP and IdP settings carried on an entity instance. */
export type SamlEntitySettings = ServiceProviderSettings &
  IdentityProviderSettings &
  EntityDefaults;
