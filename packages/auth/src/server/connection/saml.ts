import { decodeBase64urlIgnorePadding, encodeBase64urlNoPadding } from "@oslojs/encoding";
import { createIdentityProvider, createServiceProvider, setSchemaValidator } from "./saml/index";
import {
  BINDING_URI,
  DEFAULT_MAX_SAML_METADATA_SIZE,
  DEFAULT_MAX_SAML_RESPONSE_SIZE,
} from "./saml/constants";
import { safeParseXml } from "./saml/api";
export { safeParseXml };

import { log } from "../log";
import type { SAMLAttributeMapping } from "../types";
import { getSamlConfig } from "./config";
import { finalizeNormalizedProfile, normalizeStringArray } from "./profile";
import type {
  GroupSamlHttpRequest,
  GroupSamlRelayState,
  GroupSamlSource,
  ParsedSamlMetadata,
} from "./shared";
import { asRecord, getGroupSamlUrls } from "./shared";

type SamlIdpConfig = {
  metadataXml?: string;
  entityId?: string;
  issuer?: string;
  metadataUrl?: string;
  signingCert?: string | string[] | null;
  connection?: {
    redirect?: unknown;
  };
};

type SamlSpConfig = {
  entityId?: string;
  acsUrl?: string;
  sloUrl?: string;
  signingCert?: string | string[];
  encryptCert?: string | string[];
  privateKey?: string;
  privateKeyPass?: string;
  encPrivateKey?: string;
  encPrivateKeyPass?: string;
};

type SamlIdentityProvider = ReturnType<typeof createIdentityProvider>;
type SamlServiceProvider = ReturnType<typeof createSamlServiceProvider> & {
  createLoginRequest(
    idp: SamlIdentityProvider,
    binding: "redirect" | "post",
  ): SamlLoginRequest | PostBindingContext | SimpleSignBindingContext;
  parseLoginResponse(
    idp: SamlIdentityProvider,
    binding: GroupSamlHttpRequest["binding"],
    request: ESamlHttpRequest,
  ): Promise<SamlParsedFlow>;
  parseLogoutRequest(
    idp: SamlIdentityProvider,
    binding: GroupSamlHttpRequest["binding"],
    request: ESamlHttpRequest,
  ): Promise<SamlParsedFlow>;
  parseLogoutResponse(
    idp: SamlIdentityProvider,
    binding: GroupSamlHttpRequest["binding"],
    request: ESamlHttpRequest,
  ): Promise<SamlParsedFlow>;
  createLogoutResponse(
    idp: SamlIdentityProvider,
    extract: SamlParsedFlow["extract"],
    binding: GroupSamlHttpRequest["binding"],
    relayState: string,
  ): { context: string; entityEndpoint: string };
};

type FormDataEntryLike = string | { name: string };

function formDataEntries(formData: unknown): Iterable<[string, FormDataEntryLike]> {
  return (formData as { entries(): Iterable<[string, FormDataEntryLike]> }).entries();
}

/**
 * Canonical read-lens over a group connection's stored SAML config JSON.
 * Shared by the runtime SAML flow and the admin/domain code paths; all
 * fields are optional because the underlying config is loosely typed.
 */
export type SamlConfigShape = {
  enabled?: boolean;
  request?: {
    signAuthnRequests?: boolean;
    nameIdFormat?: string;
    forceAuthn?: boolean;
    authnContextClassRefs?: string[];
  };
  security?: SamlSecurityConfig;
  profile?: {
    mapping?: SAMLAttributeMapping;
    extraFields?: Record<string, string>;
  };
  idp?: SamlIdpConfig;
  serviceProvider?: SamlSpConfig;
};

const _samlifyPermissiveValidator = {
  validate: (_xml: string) => Promise.resolve("OK"),
};
/**
 * Register the SAML schema validator before parsing any SAML response.
 *
 * A permissive validator that always resolves is used because Convex's edge
 * runtime has no file-system access for XML schema files, and structural
 * correctness is already ensured by the XML parser. This is called directly
 * before each parse operation since Convex can restart the V8 isolate between
 * requests, resetting module-level state.
 */
function ensureSamlifyValidator() {
  setSchemaValidator(_samlifyPermissiveValidator);
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build an auto-submitting HTML form that POSTs a SAML message to the IdP/SP
 * endpoint (HTTP-POST binding). All interpolated values are HTML-attribute
 * escaped to prevent markup injection.
 * @internal
 */
export function createSamlPostBindingResponse(opts: {
  endpoint: string;
  parameter: "SAMLRequest" | "SAMLResponse";
  value: string;
  relayState?: string;
}) {
  const fields = [
    `<input type="hidden" name="${opts.parameter}" value="${escapeHtmlAttribute(opts.value)}" />`,
    opts.relayState
      ? `<input type="hidden" name="RelayState" value="${escapeHtmlAttribute(opts.relayState)}" />`
      : "",
  ].join("");
  return new Response(
    `<!doctype html><html><body><form method="POST" action="${escapeHtmlAttribute(opts.endpoint)}">${fields}</form><script>document.forms[0].submit();</script></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Decode a base64url RelayState into its JSON object, returning `{}` on any
 * decode/parse failure.
 * @internal
 */
export function decodeRelayState(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64urlIgnorePadding(value)));
  } catch {
    return {};
  }
}

/**
 * Encode a group connection's SAML RelayState (source, signature, requestId,
 * state, redirectTo) as a base64url JSON string.
 * @internal
 */
export function encodeGroupSamlRelayState(value: GroupSamlRelayState) {
  return encodeBase64urlNoPadding(
    new TextEncoder().encode(
      JSON.stringify({
        source: `${value.source.kind}:${value.source.id}`,
        signature: value.signature,
        requestId: value.requestId,
        state: value.state,
        redirectTo: value.redirectTo,
      }),
    ),
  );
}

/**
 * Decode and validate a group connection's SAML RelayState, throwing if it is
 * missing, malformed, or not a `connection:<id>` source.
 * @internal
 */
export function decodeGroupSamlRelayStateOrThrow(value: string | null): GroupSamlRelayState {
  if (!value) {
    throw new Error("Missing SAML RelayState.");
  }
  const decoded = decodeRelayState(value);
  if (
    typeof decoded.source !== "string" ||
    typeof decoded.signature !== "string" ||
    typeof decoded.requestId !== "string" ||
    typeof decoded.state !== "string"
  ) {
    throw new Error("Invalid SAML RelayState.");
  }
  const [kind, ...rest] = decoded.source.split(":");
  const id = rest.join(":");
  if (kind !== "connection" || id.length === 0) {
    throw new Error("Invalid group connection SAML source.");
  }
  return {
    source: { kind, id } as GroupSamlSource,
    signature: decoded.signature,
    requestId: decoded.requestId,
    state: decoded.state,
    redirectTo: typeof decoded.redirectTo === "string" ? decoded.redirectTo : undefined,
  };
}

/**
 * Read a form-encoded (urlencoded or multipart) request body into a flat
 * string map; returns `{}` for any other content type.
 * @internal
 */
export async function readRequestBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const body: Record<string, string> = {};
    for (const [key, value] of formDataEntries(form)) {
      body[key] = typeof value === "string" ? value : value.name;
    }
    return body;
  }
  return {};
}

/**
 * Normalize an incoming SAML HTTP request into a {@link GroupSamlHttpRequest},
 * resolving the binding (redirect vs post) and extracting RelayState and the
 * presence of SAMLRequest/SAMLResponse from query or body.
 * @internal
 */
export async function readGroupConnectionSamlHttpRequest(
  request: Request,
): Promise<GroupSamlHttpRequest> {
  const url = new URL(request.url);
  const body = await readRequestBody(request);
  const query = Object.fromEntries(url.searchParams);
  const binding =
    request.method === "GET"
      ? "redirect"
      : body.SAMLResponse || body.SAMLRequest
        ? "post"
        : "redirect";
  return {
    url,
    body,
    query,
    binding,
    relayState: body.RelayState ?? url.searchParams.get("RelayState") ?? undefined,
    hasSamlRequest: Boolean(body.SAMLRequest ?? url.searchParams.get("SAMLRequest")),
    hasSamlResponse: Boolean(body.SAMLResponse ?? url.searchParams.get("SAMLResponse")),
  };
}

function getSamlSecurityConfig(config: unknown): SamlSecurityConfig {
  return getSamlConfig(config).security ?? {};
}

/**
 * Parse IdP SAML metadata XML into a {@link ParsedSamlMetadata} (entityID,
 * SSO/SLO bindings, signing/encryption certs, NameID formats).
 *
 * Rejects metadata containing DTD or entity declarations to prevent XXE /
 * entity-expansion attacks against the downstream XML parser.
 * @internal
 */
export function parseSamlIdpMetadata(metadata: string): ParsedSamlMetadata {
  const source = typeof metadata === "string" ? metadata : String(metadata);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new Error("SAML metadata must not contain DTD or entity declarations.");
  }
  const entityId = source.match(/<[^>]*EntityDescriptor\b[^>]*\bentityID="([^"]+)"/i)?.[1] ?? null;
  if (!entityId) {
    throw new Error("SAML metadata is missing EntityDescriptor@entityID.");
  }

  const parseAttributes = (source: string) => {
    const attributes: Record<string, string> = {};
    for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
      attributes[match[1]] = match[2];
    }
    return attributes;
  };

  const readServiceBindings = (tagName: string) => {
    const bindings: { redirect?: string; post?: string } = {};
    const pattern = new RegExp(
      `<(?:[A-Za-z0-9_.-]+:)?${tagName}\\b([^>]*)\\/?>(?:<\\/(?:[A-Za-z0-9_.-]+:)?${tagName}>)?`,
      "gi",
    );
    for (const match of source.matchAll(pattern)) {
      const attrs = parseAttributes(match[1] ?? "");
      const binding = attrs.Binding ?? attrs.binding;
      const location = attrs.Location ?? attrs.location;
      if (!binding || !location) {
        continue;
      }
      if (binding.includes("HTTP-Redirect")) {
        bindings.redirect = location;
      }
      if (binding.includes("HTTP-POST")) {
        bindings.post = location;
      }
    }
    return bindings;
  };

  const readCertificates = (use: "signing" | "encryption") => {
    const certs: string[] = [];
    const blockPattern = new RegExp(
      `<(?:[A-Za-z0-9_.-]+:)?KeyDescriptor\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?KeyDescriptor>`,
      "gi",
    );
    for (const match of source.matchAll(blockPattern)) {
      const attrs = parseAttributes(match[1] ?? "");
      const descriptorUse = (attrs.use ?? attrs.Use ?? "signing").toLowerCase();
      if (descriptorUse !== use) {
        continue;
      }
      for (const certMatch of (match[2] ?? "").matchAll(
        /<(?:[A-Za-z0-9_.-]+:)?X509Certificate>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?X509Certificate>/gi,
      )) {
        const certificate = certMatch[1]?.replace(/\s+/g, "").trim();
        if (certificate) {
          certs.push(certificate);
        }
      }
    }
    if (certs.length === 0) {
      return null;
    }
    return certs.length === 1 ? certs[0] : certs;
  };

  const nameIdFormats = [
    ...source.matchAll(
      /<(?:[A-Za-z0-9_.-]+:)?NameIDFormat>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?NameIDFormat>/gi,
    ),
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  return {
    entityId,
    issuer: entityId,
    connection: readServiceBindings("SingleSignOnService"),
    slo: readServiceBindings("SingleLogoutService"),
    signingCert: readCertificates("signing"),
    encryptionCert: readCertificates("encryption"),
    nameIdFormats,
    wantsSignedAuthnRequests: /WantAuthnRequestsSigned="true"/i.test(source),
  };
}

/**
 * Throw if the IdP metadata XML exceeds the connection's configured
 * `maxMetadataSize`, bounding parser work against oversized payloads.
 *
 * When no limit is configured a generous default
 * ({@link DEFAULT_MAX_SAML_METADATA_SIZE}) applies so the cap is never silently
 * off; an operator may override it per connection or disable it entirely with a
 * non-positive value.
 * @internal
 */
export function enforceSamlMetadataSize(opts: { metadataXml: string; config: unknown }) {
  const configured = getSamlSecurityConfig(opts.config).maxMetadataSize;
  const maxMetadataSize =
    typeof configured === "number" ? configured : DEFAULT_MAX_SAML_METADATA_SIZE;
  if (maxMetadataSize > 0 && opts.metadataXml.length > maxMetadataSize) {
    throw new Error("SAML metadata exceeds the configured size limit.");
  }
}

/**
 * Size-check then parse IdP metadata: {@link enforceSamlMetadataSize} followed
 * by {@link parseSamlIdpMetadata}.
 * @internal
 */
export function parseSamlIdpMetadataChecked(opts: { metadataXml: string; config: unknown }) {
  enforceSamlMetadataSize(opts);
  return parseSamlIdpMetadata(opts.metadataXml);
}

/**
 * Throw if the encoded SAMLResponse exceeds the connection's configured
 * `maxResponseSize`, bounding decode/parse work against oversized payloads.
 *
 * The ACS handler base64-decodes and DOM-parses the response *before* verifying
 * its signature, so this runs on unauthenticated input. When no limit is
 * configured a generous default ({@link DEFAULT_MAX_SAML_RESPONSE_SIZE}) applies
 * so the pre-auth parser can never be handed an unbounded document; an operator
 * may override it per connection or disable it with a non-positive value.
 * @internal
 */
export function enforceSamlResponseSize(opts: { request: GroupSamlHttpRequest; config: unknown }) {
  const configured = getSamlSecurityConfig(opts.config).maxResponseSize;
  const maxResponseSize =
    typeof configured === "number" ? configured : DEFAULT_MAX_SAML_RESPONSE_SIZE;
  if (maxResponseSize <= 0) {
    return;
  }
  const encoded = opts.request.body.SAMLResponse ?? opts.request.query.SAMLResponse;
  if (typeof encoded === "string" && encoded.length > maxResponseSize) {
    throw new Error("SAML response exceeds the configured size limit.");
  }
}

/**
 * Build the SP's SAML metadata XML (entityID, ACS/SLO endpoints, signing and
 * encryption certs) for publication to the IdP.
 * @internal
 */
export function createServiceProviderMetadata(opts: {
  entityId: string;
  acsUrl: string;
  sloUrl?: string;
  authnRequestsSigned?: boolean;
  signingCert?: string | string[];
  encryptCert?: string | string[];
  privateKey?: string;
  privateKeyPass?: string;
  encPrivateKey?: string;
  encPrivateKeyPass?: string;
}) {
  const binding = BINDING_URI;
  const sp = createServiceProvider({
    entityID: opts.entityId,
    authnRequestsSigned: opts.authnRequestsSigned ?? false,
    privateKey: opts.privateKey,
    privateKeyPass: opts.privateKeyPass,
    signingCert: opts.signingCert,
    encryptCert: opts.encryptCert,
    encPrivateKey: opts.encPrivateKey,
    encPrivateKeyPass: opts.encPrivateKeyPass,
    assertionConsumerService: [
      {
        Binding: binding.post,
        Location: opts.acsUrl,
      },
    ],
    singleLogoutService: opts.sloUrl
      ? [
          {
            Binding: binding.redirect,
            Location: opts.sloUrl,
          },
          {
            Binding: binding.post,
            Location: opts.sloUrl,
          },
        ]
      : undefined,
  });
  return sp.getMetadata();
}

/**
 * Render the SP metadata XML for a specific group connection, deriving SP
 * options from its stored config via {@link getSamlServiceProviderOptions}.
 * @internal
 */
export function createGroupConnectionSamlMetadataXml(opts: {
  rootUrl: string;
  source: GroupSamlSource;
  config: unknown;
}) {
  return createServiceProviderMetadata(
    getSamlServiceProviderOptions({
      rootUrl: opts.rootUrl,
      source: opts.source,
      config: opts.config,
    }),
  );
}

/**
 * Resolve effective SP options for a group connection, layering caller
 * `overrides` over stored `serviceProvider` config over the default group
 * SAML URLs.
 * @internal
 */
export function getSamlServiceProviderOptions(opts: {
  rootUrl: string;
  source: GroupSamlSource;
  config: unknown;
  overrides?: {
    entityId?: string;
    acsUrl?: string;
    sloUrl?: string;
  };
  relayState?: string;
}) {
  const saml = getSamlConfig(opts.config);
  const sp = (asRecord(saml.serviceProvider) ?? {}) as SamlSpConfig;
  const security = (asRecord(saml.security) ?? {}) as SamlSecurityConfig;
  const clockSkewMs = (security.clockSkewSeconds ?? 300) * 1000;
  const urls = getGroupSamlUrls({
    rootUrl: opts.rootUrl,
    source: opts.source,
  });
  return {
    entityId: opts.overrides?.entityId ?? sp.entityId ?? urls.metadataUrl,
    acsUrl: opts.overrides?.acsUrl ?? sp.acsUrl ?? urls.acsUrl,
    sloUrl: opts.overrides?.sloUrl ?? sp.sloUrl ?? urls.sloUrl,
    relayState: opts.relayState,
    authnRequestsSigned: saml.request?.signAuthnRequests,
    signingCert: sp.signingCert,
    encryptCert: sp.encryptCert,
    privateKey: sp.privateKey,
    privateKeyPass: sp.privateKeyPass,
    encPrivateKey: sp.encPrivateKey,
    encPrivateKeyPass: sp.encPrivateKeyPass,
    clockDrifts: [-clockSkewMs, clockSkewMs] as [number, number],
  };
}

/**
 * Construct a samlify ServiceProvider from resolved SP options (entityID,
 * ACS/SLO endpoints, signing config).
 * @internal
 */
export function createSamlServiceProvider(opts: {
  entityId: string;
  acsUrl: string;
  sloUrl?: string;
  relayState?: string;
  authnRequestsSigned?: boolean;
  signingCert?: string | string[];
  encryptCert?: string | string[];
  privateKey?: string;
  privateKeyPass?: string;
  encPrivateKey?: string;
  encPrivateKeyPass?: string;
  clockDrifts?: [number, number];
}) {
  const binding = BINDING_URI;
  return createServiceProvider({
    entityID: opts.entityId,
    relayState: opts.relayState ?? "",
    authnRequestsSigned: opts.authnRequestsSigned ?? false,
    privateKey: opts.privateKey,
    privateKeyPass: opts.privateKeyPass,
    signingCert: opts.signingCert,
    encryptCert: opts.encryptCert,
    encPrivateKey: opts.encPrivateKey,
    encPrivateKeyPass: opts.encPrivateKeyPass,
    clockDrifts: opts.clockDrifts,
    assertionConsumerService: [
      {
        Binding: binding.post,
        Location: opts.acsUrl,
      },
    ],
    singleLogoutService: opts.sloUrl
      ? [
          { Binding: binding.redirect, Location: opts.sloUrl },
          { Binding: binding.post, Location: opts.sloUrl },
        ]
      : undefined,
  });
}

/**
 * Build the per-request SAML runtime (SP, IdP, and group URLs) for a group
 * connection. Throws if the connection has no stored IdP metadata XML.
 * @internal
 */
export function createGroupConnectionSamlRuntime(opts: {
  rootUrl: string;
  source: GroupSamlSource;
  config: unknown;
  relayState?: string;
  overrides?: {
    entityId?: string;
    acsUrl?: string;
    sloUrl?: string;
  };
}) {
  const saml = getSamlConfig(opts.config);
  const spOptions = getSamlServiceProviderOptions({
    rootUrl: opts.rootUrl,
    source: opts.source,
    config: opts.config,
    relayState: opts.relayState,
    overrides: opts.overrides,
  });
  if (typeof saml.idp?.metadataXml !== "string") {
    throw new Error("SAML IdP metadata is missing.");
  }
  return {
    saml,
    sp: createSamlServiceProvider(spOptions) as SamlServiceProvider,
    idp: createIdentityProvider({
      metadata: saml.idp.metadataXml,
    }) as SamlIdentityProvider,
    urls: getGroupSamlUrls({ rootUrl: opts.rootUrl, source: opts.source }),
  };
}

type SamlLoginRequest = BindingContext & {
  entityEndpoint?: string;
};

type BindingContext = {
  context: string;
  id: string;
};

type PostBindingContext = BindingContext & {
  relayState?: string;
  entityEndpoint: string;
  type: string;
};

type SimpleSignBindingContext = PostBindingContext & {
  sigAlg?: string;
  signature?: string;
  keyInfo?: string;
};

type ESamlHttpRequest = {
  query: Record<string, string>;
  body: Record<string, string>;
  octetString?: string;
};

type FlowResult = {
  samlContent: string;
  extract: SamlParsedExtract;
  sigAlg?: string | null;
};

type SamlParsedExtract = {
  signature?: {
    signatureAlgorithm?: string;
    digestAlgorithm?: string;
  };
  assertionSignature?:
    | string
    | {
        signatureAlgorithm?: string;
        digestAlgorithm?: string;
      }
    | null;
  conditions?: {
    notBefore?: string;
    notOnOrAfter?: string;
  };
  response?: {
    signatureAlgorithm?: string;
    inResponseTo?: string;
    destination?: string;
  };
  audience?: string | string[] | null;
  subjectConfirmation?: {
    notOnOrAfter?: string;
    recipient?: string;
    inResponseTo?: string;
  } | null;
  attributes?: Record<string, unknown>;
  nameID?: string;
  sessionIndex?: { sessionIndex?: string };
};

type SamlParsedFlow = FlowResult & {
  extract?: SamlParsedExtract;
};

type SamlSecurityConfig = {
  requireSignedAssertions?: boolean;
  requireTimestamps?: boolean;
  clockSkewSeconds?: number;
  weakAlgorithmHandling?: "warn" | "reject";
  maxMetadataSize?: number;
  maxResponseSize?: number;
};

function verifySamlTimeWindow(
  notBefore: string | undefined,
  notOnOrAfter: string | undefined,
  clockSkewSeconds: number,
) {
  const now = Date.now();
  const drift = clockSkewSeconds * 1000;
  if (notBefore) {
    const notBeforeTime = new Date(notBefore).getTime();
    if (!Number.isFinite(notBeforeTime)) {
      throw new Error("SAML assertion has an invalid NotBefore timestamp.");
    }
    if (now < notBeforeTime - drift) {
      throw new Error("SAML assertion is not yet valid.");
    }
  }
  if (notOnOrAfter) {
    const notOnOrAfterTime = new Date(notOnOrAfter).getTime();
    if (!Number.isFinite(notOnOrAfterTime)) {
      throw new Error("SAML assertion has an invalid NotOnOrAfter timestamp.");
    }
    if (now >= notOnOrAfterTime + drift) {
      throw new Error("SAML assertion has expired.");
    }
  }
}

function normalizeSamlUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function toStringArray(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

type SignatureMetadata = {
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
};

function localName(node: unknown) {
  return typeof node === "object" && node !== null
    ? ((node as { localName?: string; nodeName?: string }).localName ??
        (node as { nodeName?: string }).nodeName)
    : undefined;
}

function isElementNode(node: unknown): node is object {
  return localName(node) !== undefined;
}

function elementChildren(node: unknown): object[] {
  const childNodes =
    typeof node === "object" && node !== null
      ? (node as { childNodes?: ArrayLike<unknown> }).childNodes
      : undefined;
  return childNodes ? Array.from(childNodes).filter(isElementNode) : [];
}

function findDirectChild(node: unknown, name: string): object | undefined {
  return elementChildren(node).find((child) => localName(child) === name);
}

function findDescendant(node: unknown, name: string): object | undefined {
  for (const child of elementChildren(node)) {
    if (localName(child) === name) {
      return child;
    }
    const nested = findDescendant(child, name);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function getAttribute(node: unknown, name: string): string | undefined {
  if (typeof node !== "object" || node === null) {
    return undefined;
  }
  const getAttribute = (node as { getAttribute?: (key: string) => string | null }).getAttribute;
  const value = getAttribute?.call(node, name);
  return typeof value === "string" ? value : undefined;
}

function signatureMetadataFromNode(signatureNode: unknown): SignatureMetadata | undefined {
  if (!signatureNode) {
    return undefined;
  }
  const signatureMethod = findDescendant(signatureNode, "SignatureMethod");
  const digestMethod = findDescendant(signatureNode, "DigestMethod");
  return {
    signatureAlgorithm: getAttribute(signatureMethod, "Algorithm"),
    digestAlgorithm: getAttribute(digestMethod, "Algorithm"),
  };
}

function extractSignatureMetadataFromXml(content: string) {
  try {
    const doc = safeParseXml(content, "text/xml");
    const root = doc.documentElement;
    if (localName(root) === "Signature") {
      return { responseSignature: signatureMetadataFromNode(root) };
    }
    const responseSignature = signatureMetadataFromNode(findDirectChild(root, "Signature"));
    const assertion = localName(root) === "Assertion" ? root : findDirectChild(root, "Assertion");
    const assertionSignature =
      localName(root) === "Assertion"
        ? signatureMetadataFromNode(findDirectChild(root, "Signature"))
        : signatureMetadataFromNode(findDirectChild(assertion, "Signature"));
    return { responseSignature, assertionSignature };
  } catch {
    return {};
  }
}

/**
 * Read the `Assertion/@ID` from cryptographically-verified SAML content,
 * whether the content is the assertion element itself or a response wrapping
 * one. Returns `undefined` when no assertion ID can be resolved (in which case
 * the caller must fail closed rather than treat the response as unique).
 */
function assertionIdFromXml(content: string): string | undefined {
  try {
    const doc = safeParseXml(content, "text/xml");
    const root = doc.documentElement;
    const assertion = localName(root) === "Assertion" ? root : findDirectChild(root, "Assertion");
    const id = getAttribute(assertion, "ID");
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive the identifiers a SAML ACS handler needs to prevent replay from a
 * parsed login response: the assertion's `ID` (verified from the canonical
 * bytes), the `InResponseTo` binding the response to a pending AuthnRequest,
 * and the tightest `NotOnOrAfter` upper bound (from `<SubjectConfirmationData>`
 * or `<Conditions>`) used to bound the seen-assertion cache's TTL.
 * @internal
 */
export function samlReplayIdentifiers(parsed: {
  samlContent: string;
  extract?: SamlParsedExtract;
}): {
  assertionId?: string;
  inResponseTo?: string;
  notOnOrAfter?: string;
} {
  const extract = parsed.extract;
  const notOnOrAfter =
    extract?.subjectConfirmation?.notOnOrAfter ?? extract?.conditions?.notOnOrAfter ?? undefined;
  return {
    assertionId: assertionIdFromXml(parsed.samlContent),
    inResponseTo: extract?.subjectConfirmation?.inResponseTo ?? extract?.response?.inResponseTo,
    notOnOrAfter,
  };
}

function normalizeSignatureMetadata(value: unknown): SignatureMetadata | undefined {
  if (typeof value === "object" && value !== null) {
    const signatureAlgorithm = (value as { signatureAlgorithm?: unknown }).signatureAlgorithm;
    const digestAlgorithm = (value as { digestAlgorithm?: unknown }).digestAlgorithm;
    if (typeof signatureAlgorithm === "string" || typeof digestAlgorithm === "string") {
      return {
        signatureAlgorithm: typeof signatureAlgorithm === "string" ? signatureAlgorithm : undefined,
        digestAlgorithm: typeof digestAlgorithm === "string" ? digestAlgorithm : undefined,
      };
    }
  }
  if (typeof value === "string") {
    return extractSignatureMetadataFromXml(value).responseSignature;
  }
  return undefined;
}

function attachSamlSignatureMetadata(parsed: SamlParsedFlow): SamlParsedFlow {
  const fromXml = extractSignatureMetadataFromXml(parsed.samlContent);
  const responseSignature =
    normalizeSignatureMetadata(parsed.extract?.signature) ?? fromXml.responseSignature;
  const assertionSignature =
    normalizeSignatureMetadata(parsed.extract?.assertionSignature) ?? fromXml.assertionSignature;
  return {
    ...parsed,
    extract: {
      ...parsed.extract,
      signature: responseSignature,
      assertionSignature,
    },
  };
}

function signatureMetadataList(extract: SamlParsedExtract | undefined): SignatureMetadata[] {
  return [
    normalizeSignatureMetadata(extract?.signature),
    normalizeSignatureMetadata(extract?.assertionSignature),
  ].filter((metadata): metadata is SignatureMetadata => metadata !== undefined);
}

function validateSamlRequiredSignature(
  extract: SamlParsedExtract | undefined,
  security: SamlSecurityConfig,
) {
  if (
    security.requireSignedAssertions === true &&
    typeof normalizeSignatureMetadata(extract?.assertionSignature)?.signatureAlgorithm !== "string"
  ) {
    throw new Error("SAML assertion must be signed.");
  }
}

function validateSamlRequiredTimestamps(
  extract: SamlParsedExtract | undefined,
  security: SamlSecurityConfig,
) {
  // Secure by default: an assertion must carry an upper validity bound
  // (`NotOnOrAfter`), from either `<Conditions>` or `<SubjectConfirmationData>`,
  // so a captured assertion isn't valid indefinitely. Operators can opt out with
  // `security.requireTimestamps: false`.
  if (security.requireTimestamps === false) {
    return;
  }
  const hasUpperBound =
    Boolean(extract?.conditions?.notOnOrAfter) ||
    Boolean(extract?.subjectConfirmation?.notOnOrAfter);
  if (!hasUpperBound) {
    throw new Error("SAML assertion is missing a validity window (NotOnOrAfter).");
  }
}

function validateSamlTimeWindow(
  extract: SamlParsedExtract | undefined,
  security: SamlSecurityConfig,
) {
  const skew = security.clockSkewSeconds ?? 300;
  const conditions = extract?.conditions;
  if (conditions?.notBefore || conditions?.notOnOrAfter) {
    verifySamlTimeWindow(conditions.notBefore, conditions.notOnOrAfter, skew);
  }
  const subjectNotOnOrAfter = extract?.subjectConfirmation?.notOnOrAfter;
  if (subjectNotOnOrAfter) {
    verifySamlTimeWindow(undefined, subjectNotOnOrAfter, skew);
  }
}

function validateSamlAudience(extract: SamlParsedExtract | undefined, expectedAudience?: string) {
  if (expectedAudience !== undefined) {
    const audiences = toStringArray(extract?.audience);
    if (!audiences.includes(expectedAudience)) {
      throw new Error("SAML assertion audience does not match this service provider.");
    }
  }
}

function validateSamlRecipient(extract: SamlParsedExtract | undefined, expectedAcsUrl?: string) {
  if (expectedAcsUrl !== undefined) {
    const normalizedAcsUrl = normalizeSamlUrl(expectedAcsUrl);
    const recipient = extract?.subjectConfirmation?.recipient;
    if (typeof recipient !== "string" || normalizeSamlUrl(recipient) !== normalizedAcsUrl) {
      throw new Error("SAML assertion recipient does not match this ACS URL.");
    }
    const destination = extract?.response?.destination;
    if (typeof destination === "string" && normalizeSamlUrl(destination) !== normalizedAcsUrl) {
      throw new Error("SAML response destination does not match this ACS URL.");
    }
  }
}

/**
 * Enforce the connection's SAML security policy on a parsed assertion:
 * weak-algorithm rejection, required assertion signature, required timestamp
 * conditions, the NotBefore/NotOnOrAfter validity window (with clock skew),
 * the expected audience, and recipient/destination matching the SP's ACS URL.
 * Throws on the first violation.
 * @internal
 */
export function enforceGroupConnectionSamlSecurity(opts: {
  extract: SamlParsedExtract | undefined;
  config: unknown;
  expectedAudience?: string;
  expectedAcsUrl?: string;
}) {
  enforceSamlAlgorithmPolicy(opts);
  const saml = getSamlConfig(opts.config);
  const security = (asRecord(saml.security) ?? {}) as SamlSecurityConfig;

  validateSamlRequiredSignature(opts.extract, security);
  validateSamlRequiredTimestamps(opts.extract, security);
  validateSamlTimeWindow(opts.extract, security);
  validateSamlAudience(opts.extract, opts.expectedAudience);
  validateSamlRecipient(opts.extract, opts.expectedAcsUrl);
}

/**
 * Reconstruct the HTTP-Redirect binding's signed octet string from the raw query
 * string, in the SAML-mandated order (`SAMLRequest`|`SAMLResponse`, then
 * `RelayState` if present, then `SigAlg`), preserving each value's exact
 * URL-encoded bytes — re-encoding decoded values would not reproduce what the IdP
 * signed. Returns `undefined` when no SAML message parameter is present, in which
 * case message-signature verification stays fail-closed.
 * @internal
 */
export function reconstructRedirectOctetString(url: URL): string | undefined {
  const raw = url.search.replace(/^\?/, "");
  const encoded = new Map<string, string>();
  for (const pair of raw.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (!encoded.has(key)) {
      encoded.set(key, eq === -1 ? "" : pair.slice(eq + 1));
    }
  }
  const message = encoded.has("SAMLRequest")
    ? `SAMLRequest=${encoded.get("SAMLRequest")}`
    : encoded.has("SAMLResponse")
      ? `SAMLResponse=${encoded.get("SAMLResponse")}`
      : undefined;
  if (message === undefined) {
    return undefined;
  }
  const parts = [message];
  if (encoded.has("RelayState")) {
    parts.push(`RelayState=${encoded.get("RelayState")}`);
  }
  if (encoded.has("SigAlg")) {
    parts.push(`SigAlg=${encoded.get("SigAlg")}`);
  }
  return parts.join("&");
}

function toSamlHttpRequest(request: GroupSamlHttpRequest): ESamlHttpRequest {
  return {
    query: request.query,
    body: request.body,
    ...(request.binding === "redirect"
      ? { octetString: reconstructRedirectOctetString(request.url) }
      : {}),
  };
}

/**
 * Create the IdP-bound SAML AuthnRequest for a group connection, returning the
 * binding plus either a redirect URL (HTTP-Redirect) or POST endpoint/value
 * (HTTP-POST), along with the encoded RelayState carrying the signed flow
 * state and request id.
 * @internal
 */
export async function createGroupConnectionSamlSignInRequest(opts: {
  rootUrl: string;
  source: GroupSamlSource;
  config: unknown;
  state: string;
  signature: string;
  redirectTo?: string;
}) {
  const runtime = createGroupConnectionSamlRuntime({
    rootUrl: opts.rootUrl,
    source: opts.source,
    config: opts.config,
  });
  const binding = runtime.saml.idp?.connection?.redirect ? "redirect" : "post";
  const loginRequest = (await runtime.sp.createLoginRequest(runtime.idp, binding)) as
    | SamlLoginRequest
    | PostBindingContext
    | SimpleSignBindingContext;
  const relayState = encodeGroupSamlRelayState({
    source: opts.source,
    signature: opts.signature,
    requestId: loginRequest.id,
    state: opts.state,
    redirectTo: opts.redirectTo,
  });
  return {
    requestId: loginRequest.id as string,
    binding,
    relayState,
    redirectUrl:
      binding === "redirect"
        ? (() => {
            const redirectUrl = new URL(loginRequest.context);
            redirectUrl.searchParams.set("RelayState", relayState);
            return redirectUrl.toString();
          })()
        : undefined,
    post:
      binding === "post"
        ? {
            endpoint: loginRequest.entityEndpoint as string,
            value: loginRequest.context as string,
          }
        : undefined,
  };
}

/**
 * Parse and partially validate a SAML login Response for a group connection:
 * enforces the response size limit, builds the runtime, parses the response,
 * attaches signature metadata, warns on weak algorithms, and decodes the
 * RelayState. Does not itself enforce the full security policy — callers must
 * also run {@link enforceGroupConnectionSamlSecurity}.
 * @internal
 */
export async function parseGroupConnectionSamlLoginResponse(opts: {
  request: Request;
  rootUrl: string;
  source: GroupSamlSource;
  config: unknown;
}) {
  ensureSamlifyValidator();
  const httpRequest = await readGroupConnectionSamlHttpRequest(opts.request);
  enforceSamlResponseSize({ request: httpRequest, config: opts.config });
  const runtime = createGroupConnectionSamlRuntime({
    rootUrl: opts.rootUrl,
    source: opts.source,
    config: opts.config,
  });
  const parsed = attachSamlSignatureMetadata(
    (await runtime.sp.parseLoginResponse(
      runtime.idp,
      httpRequest.binding,
      toSamlHttpRequest(httpRequest),
    )) as SamlParsedFlow,
  );
  warnWeakSamlAlgorithms(parsed);

  return {
    ...httpRequest,
    runtime,
    parsed,
    relayState: decodeGroupSamlRelayStateOrThrow(httpRequest.relayState ?? null),
  };
}

const WEAK_SAML_ALGORITHMS = new Set([
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  "http://www.w3.org/2000/09/xmldsig#dsa-sha1",
  "http://www.w3.org/2000/09/xmldsig#sha1",
  "http://www.w3.org/2001/04/xmlenc#rsa-1_5",
  "http://www.w3.org/2001/04/xmlenc#tripledes-cbc",
]);

/**
 * Warn when the SAML response uses weak cryptographic algorithms
 * such as SHA-1, RSA 1.5, or 3DES. Algorithm-check failures are non-critical
 * and swallowed so they never break the auth flow.
 */
function warnWeakSamlAlgorithms(parsed: SamlParsedFlow) {
  try {
    for (const metadata of signatureMetadataList(parsed.extract)) {
      const sigAlg = metadata.signatureAlgorithm;
      const digestAlg = metadata.digestAlgorithm;

      if (sigAlg && WEAK_SAML_ALGORITHMS.has(sigAlg)) {
        log(
          "WARN",
          `[convex-auth] SAML response uses weak signature algorithm: ${sigAlg}. ` +
            `Consider upgrading your IdP to use RSA-SHA256 or stronger.`,
        );
      }
      if (digestAlg && WEAK_SAML_ALGORITHMS.has(digestAlg)) {
        log(
          "WARN",
          `[convex-auth] SAML response uses weak digest algorithm: ${digestAlg}. ` +
            `Consider upgrading your IdP to use SHA-256 or stronger.`,
        );
      }
    }
  } catch {
    return;
  }
}

/**
 * Reject a SAML response/assertion whose signature or digest uses a known-weak
 * algorithm (SHA-1, RSA-1.5, 3DES). Secure by default: rejection is the default
 * and operators must explicitly set `security.weakAlgorithmHandling: "warn"` to
 * downgrade to a warning (mirroring the `requireTimestamps` opt-out).
 * @internal
 */
export function enforceSamlAlgorithmPolicy(opts: {
  extract: SamlParsedExtract | undefined;
  config: unknown;
}) {
  const handling = getSamlSecurityConfig(opts.config).weakAlgorithmHandling;
  if (handling === "warn") {
    return;
  }
  for (const metadata of signatureMetadataList(opts.extract)) {
    const sigAlg = metadata.signatureAlgorithm;
    const digestAlg = metadata.digestAlgorithm;
    if (
      (sigAlg && WEAK_SAML_ALGORITHMS.has(sigAlg)) ||
      (digestAlg && WEAK_SAML_ALGORITHMS.has(digestAlg))
    ) {
      throw new Error("SAML response uses a rejected weak cryptographic algorithm.");
    }
  }
}

/**
 * Bind the returned RelayState to the pending login request: throws unless its
 * source matches the connection and its requestId matches the assertion's
 * `InResponseTo`, defeating cross-connection and replayed responses.
 * @internal
 */
export function validateGroupConnectionSamlLoginRelayState(opts: {
  relayState: GroupSamlRelayState;
  source: GroupSamlSource;
  inResponseTo?: string;
}) {
  if (
    opts.relayState.source.kind !== opts.source.kind ||
    opts.relayState.source.id !== opts.source.id ||
    opts.relayState.requestId !== opts.inResponseTo
  ) {
    throw new Error("SAML RelayState did not match the pending login request.");
  }
}

/**
 * Parse an inbound SAML single-logout message (request and/or response) for a
 * group connection, returning the parsed flow(s) alongside the runtime.
 *
 * SECURITY — SLO messages are treated as UNAUTHENTICATED. samlify only verifies
 * an inbound `LogoutRequest`/`LogoutResponse` signature when the SP is built
 * with `wantLogoutRequestSigned`/`wantLogoutResponseSigned`; both default to
 * `false` and are intentionally left unset in {@link createSamlServiceProvider}
 * (many IdPs do not sign logout messages, and requiring it would break those
 * legitimate SLO flows). This is safe only because the sole caller,
 * `handleSamlSlo` in the connection HTTP router, DOES NOT terminate any local
 * session: for an inbound `LogoutRequest` it merely emits the protocol
 * `LogoutResponse` acknowledgment, and for an inbound `LogoutResponse` it
 * returns `204` and does nothing. A forged, replayed, or attacker-supplied
 * logout message therefore cannot force-log-out a user.
 *
 * DO NOT wire session termination onto this parse result without FIRST requiring
 * signed logout messages (via the `wantLogout*Signed` SP options above) and
 * rejecting unsigned ones — otherwise an unauthenticated caller could trigger a
 * logout-CSRF / denial-of-service.
 * @internal
 */
export async function parseGroupConnectionSamlLogoutMessage(opts: {
  request: Request;
  rootUrl: string;
  source: GroupSamlSource;
  config: unknown;
}) {
  ensureSamlifyValidator();
  const httpRequest = await readGroupConnectionSamlHttpRequest(opts.request);
  const runtime = createGroupConnectionSamlRuntime({
    rootUrl: opts.rootUrl,
    source: opts.source,
    config: opts.config,
    relayState: httpRequest.relayState,
  });
  const parsedRequest = httpRequest.hasSamlRequest
    ? ((await runtime.sp.parseLogoutRequest(
        runtime.idp,
        httpRequest.binding,
        toSamlHttpRequest(httpRequest),
      )) as SamlParsedFlow)
    : undefined;
  const parsedResponse = httpRequest.hasSamlResponse
    ? ((await runtime.sp.parseLogoutResponse(
        runtime.idp,
        httpRequest.binding,
        toSamlHttpRequest(httpRequest),
      )) as SamlParsedFlow)
    : undefined;
  return {
    ...httpRequest,
    runtime,
    parsedRequest,
    parsedResponse,
  };
}

/**
 * Map a parsed SAML assertion's attributes (via the connection's attribute
 * mapping, falling back to NameID for the subject) into a normalized profile.
 * Throws if no subject can be resolved.
 *
 * @remarks
 * `emailVerified` is always left `undefined`: SAML carries no `email_verified`
 * claim, so the assertion alone never proves the email. Verification is decided
 * downstream (`userOAuthImpl`) from whether the email's domain is a verified
 * connection domain, keeping a SAML-asserted email unverified by default so it
 * cannot drive cross-connection `verifiedEmail` account linking.
 * @internal
 */
export function profileFromSamlExtract(
  extract: SamlParsedExtract | undefined,
  mapping?: SAMLAttributeMapping,
) {
  const attributes =
    typeof extract?.attributes === "object" && extract.attributes !== null
      ? (extract.attributes as Record<string, unknown>)
      : {};
  const resolveFirst = (...keys: Array<string | undefined>) => {
    for (const key of keys) {
      if (!key) {
        continue;
      }
      const attribute = attributes[key];
      const value = Array.isArray(attribute) ? attribute[0] : attribute;
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const fieldResolvers = {
    email: () => resolveFirst(mapping?.email),
    groups: () => normalizeStringArray(resolveFirst(mapping?.groups)),
    name: () =>
      resolveFirst(mapping?.name) ??
      ([resolveFirst(mapping?.firstName), resolveFirst(mapping?.lastName)]
        .filter(Boolean)
        .join(" ") ||
        undefined),
    roles: () => normalizeStringArray(resolveFirst(mapping?.roles)),
    subject: () => resolveFirst(mapping?.subject) ?? (extract?.nameID as string | undefined),
  } as const;
  const subject = fieldResolvers.subject() as string | undefined;
  if (subject === undefined) {
    throw new Error(
      "SAML profile is missing a subject. Configure `attributeMapping.subject` or ensure the assertion includes a NameID.",
    );
  }
  const email = fieldResolvers.email() as string | undefined;
  const groups = fieldResolvers.groups() as string[] | undefined;
  const name = fieldResolvers.name() as string | undefined;
  const roles = fieldResolvers.roles() as string[] | undefined;
  return finalizeNormalizedProfile({
    id: subject,
    email,
    emailVerified: undefined,
    groups,
    name,
    roles,
    samlAttributes: attributes,
    samlSessionIndex: extract?.sessionIndex?.sessionIndex as string | undefined,
  });
}
