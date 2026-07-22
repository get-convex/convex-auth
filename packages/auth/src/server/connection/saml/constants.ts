/** The transport binding an SP↔IdP exchange uses; the short-name key into {@link BINDING_URI}. */
export type BindingKind = "redirect" | "post";

/** SAML 2.0 protocol-binding URIs, keyed by binding short-name. */
export const BINDING_URI = {
  redirect: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  post: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
  artifact: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact",
} as const;

/** The kind of SAML message a flow parses; the value doubles as the wire query-param name. */
export type SamlMessageKind = "SAMLRequest" | "SAMLResponse" | "LogoutRequest" | "LogoutResponse";

/** Redirect-binding query-param names carried alongside the message body. */
export const SamlQueryParam = {
  sigAlg: "SigAlg",
  signature: "Signature",
  relayState: "RelayState",
} as const;

/** XML element-namespace URIs used when building SAML documents. */
export const SamlNamespace = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
} as const;

/** SAML 2.0 NameID-format URIs. */
export const NameIdFormat = {
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  entity: "urn:oasis:names:tc:SAML:2.0:nameid-format:entity",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  kerberos: "urn:oasis:names:tc:SAML:2.0:nameid-format:kerberos",
  windowsDomainQualifiedName:
    "urn:oasis:names:tc:SAML:1.1:nameid-format:WindowsDomainQualifiedName",
  x509SubjectName: "urn:oasis:names:tc:SAML:1.1:nameid-format:X509SubjectName",
} as const;

/** The success status-code URI — the only SAML status this library asserts on. */
export const SAML_STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

/** XML-dsig signature algorithm URIs. */
export const SignatureAlgorithm = {
  RSA_SHA1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  RSA_SHA256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
} as const;

/** Bulk-data XML-enc algorithm URIs. */
export const DataEncryptionAlgorithm = {
  AES_128: "http://www.w3.org/2001/04/xmlenc#aes128-cbc",
  AES_256: "http://www.w3.org/2001/04/xmlenc#aes256-cbc",
  AES_128_GCM: "http://www.w3.org/2009/xmlenc11#aes128-gcm",
} as const;

/** Key-transport XML-enc algorithm URIs. */
export const KeyEncryptionAlgorithm = {
  RSA_OAEP_MGF1P: "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p",
} as const;

/** The digest algorithm URI paired with each signature algorithm URI. */
export const DIGEST_BY_SIGNATURE: Record<string, string> = {
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": "http://www.w3.org/2000/09/xmldsig#sha1",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "http://www.w3.org/2001/04/xmlenc#sha256",
};

/** Whether a message is signed-then-encrypted or encrypted-then-signed. */
export const SigningOrder = {
  SIGN_THEN_ENCRYPT: "sign-then-encrypt",
  ENCRYPT_THEN_SIGN: "encrypt-then-sign",
} as const;

/**
 * Default upper bound (in characters of the received payload) on an inbound
 * `SAMLResponse`, applied when a connection sets no explicit
 * `security.maxResponseSize`. The ACS handler base64-decodes and DOM-parses the
 * response *before* any signature is verified, so an unauthenticated caller
 * could otherwise feed an unbounded document into the parser; this generous cap
 * (~500 KB, far above any legitimate assertion — even encrypted, multi-cert
 * ones) bounds that pre-auth work while staying operator-overridable. A
 * configured non-positive limit disables the cap.
 */
export const DEFAULT_MAX_SAML_RESPONSE_SIZE = 500_000;

/**
 * Default upper bound (in characters) on an IdP metadata XML document, applied
 * when a connection sets no explicit `security.maxMetadataSize`. Mirrors
 * {@link DEFAULT_MAX_SAML_RESPONSE_SIZE}: generous enough for any real IdP
 * metadata while bounding parser work against an oversized payload. A configured
 * non-positive limit disables the cap.
 */
export const DEFAULT_MAX_SAML_METADATA_SIZE = 500_000;

/** Required child-element ordering of an SPSSODescriptor, per IdP vendor profile. */
export const ElementsOrder: Record<"default" | "onelogin" | "shibboleth", string[]> = {
  default: ["KeyDescriptor", "NameIDFormat", "SingleLogoutService", "AssertionConsumerService"],
  onelogin: ["KeyDescriptor", "NameIDFormat", "SingleLogoutService", "AssertionConsumerService"],
  shibboleth: [
    "KeyDescriptor",
    "SingleLogoutService",
    "NameIDFormat",
    "AssertionConsumerService",
    "AttributeConsumingService",
  ],
};
