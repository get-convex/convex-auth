/**
 * Offline SAML engine unit tests (audit finding H16 — SAML was interop-only).
 *
 * The de-vendored SAML engine has a layer of pure, deterministic functions that
 * decide security-relevant outcomes on a plain input string, with no clock,
 * network, or real key material. Those are testable offline here (the Docker
 * interop suite only exercises the happy path). This file complements the
 * existing `saml-signature.test.ts` (XSW / unsigned / AES-CBC / redirect
 * octet-string) and does not duplicate it.
 *
 * Covered: the hardened XML parser's XXE/DTD rejection (shared by every
 * network-facing parse sink), canonicalization-transform resolution, assertion
 * field extraction, IdP-metadata parsing, deflate/base64 encoding round-trips,
 * additional decrypt rejection paths, and the validity-window check at
 * clock-independent boundaries.
 *
 * NOT covered (interop-only — flagged in the H16 report): the full ACS flow in
 * `flow.ts`, which welds verify+extract+time-check behind `verifyTime()`'s
 * non-injectable `new Date()` clock; real signature verification and AES-GCM
 * decryption (need live RSA keys + a signing IdP); and clock-*skew*-boundary
 * timing, which needs the injectable clock the engine does not expose.
 */

import {
  extract,
  loginResponseStatusFields,
} from "@robelest/convex-auth/server/connection/saml/extractor";
import { getTransformByAlgorithm } from "@robelest/convex-auth/server/connection/saml/c14n";
import {
  base64Decode,
  base64Encode,
  deflateString,
  inflateString,
} from "@robelest/convex-auth/server/connection/saml/encoding";
import { parseIdpMetadata } from "@robelest/convex-auth/server/connection/saml/metadata";
import { safeParseXml } from "@robelest/convex-auth/server/connection/saml/api";
import { decryptAssertion } from "@robelest/convex-auth/server/connection/saml/xmlenc";
import { verifyTime } from "@robelest/convex-auth/server/connection/saml/validator";
import { expect, test } from "vite-plus/test";

// ---------------------------------------------------------------------------
// Hardened XML parsing — XXE / DTD rejection (api.safeParseXml)
// ---------------------------------------------------------------------------

test("safeParseXml rejects a DOCTYPE declaration (billion-laughs / XXE surface)", () => {
  const doctype =
    `<?xml version="1.0"?>` +
    `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
    `<foo>&xxe;</foo>`;
  expect(() => safeParseXml(doctype)).toThrow("ERR_XML_DOCTYPE_OR_ENTITY_FORBIDDEN");
});

test("safeParseXml rejects a standalone ENTITY declaration", () => {
  const entity = `<!ENTITY x "y"><root/>`;
  expect(() => safeParseXml(entity)).toThrow("ERR_XML_DOCTYPE_OR_ENTITY_FORBIDDEN");
});

test("safeParseXml rejects DOCTYPE regardless of surrounding whitespace/casing", () => {
  expect(() => safeParseXml(`<!  doctype html><x/>`)).toThrow(
    "ERR_XML_DOCTYPE_OR_ENTITY_FORBIDDEN",
  );
});

test("safeParseXml parses well-formed XML with no doctype", () => {
  const doc = safeParseXml(`<root><child>hi</child></root>`);
  expect(doc.documentElement.nodeName).toBe("root");
});

// ---------------------------------------------------------------------------
// Canonicalization transform resolution (c14n.getTransformByAlgorithm)
// ---------------------------------------------------------------------------

test("getTransformByAlgorithm resolves exclusive c14n and enveloped-signature", () => {
  const c14n = getTransformByAlgorithm("http://www.w3.org/2001/10/xml-exc-c14n#");
  expect(c14n.getAlgorithmName()).toBe("http://www.w3.org/2001/10/xml-exc-c14n#");

  const env = getTransformByAlgorithm("http://www.w3.org/2000/09/xmldsig#enveloped-signature");
  expect(env.getAlgorithmName()).toBe("http://www.w3.org/2000/09/xmldsig#enveloped-signature");
});

test("getTransformByAlgorithm rejects an unknown transform URI", () => {
  expect(() => getTransformByAlgorithm("http://example.com/not-a-transform")).toThrow(
    "is not supported",
  );
});

// ---------------------------------------------------------------------------
// Assertion field extraction (extractor.extract)
// ---------------------------------------------------------------------------

test("extract pulls nested StatusCode values from a Response", () => {
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder">` +
    `<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"/>` +
    `</samlp:StatusCode></samlp:Status></samlp:Response>`;
  const extracted = extract<{ top?: string; second?: string }>(xml, loginResponseStatusFields);
  expect(extracted.top).toBe("urn:oasis:names:tc:SAML:2.0:status:Responder");
  expect(extracted.second).toBe("urn:oasis:names:tc:SAML:2.0:status:AuthnFailed");
});

test("extract reads an element's text content via a text field", () => {
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
    `<saml:Issuer>https://idp.example/entity</saml:Issuer></samlp:Response>`;
  const extracted = extract<{ issuer?: string }>(xml, [
    { key: "issuer", localPath: ["Response", "Issuer"], attributes: [] },
  ]);
  expect(extracted.issuer).toBe("https://idp.example/entity");
});

test("extract inherits the parser's DOCTYPE/ENTITY rejection", () => {
  const poisoned =
    `<!DOCTYPE Response [<!ENTITY e "x">]>` +
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>`;
  expect(() => extract(poisoned, loginResponseStatusFields)).toThrow(
    "ERR_XML_DOCTYPE_OR_ENTITY_FORBIDDEN",
  );
});

// ---------------------------------------------------------------------------
// IdP metadata parsing (metadata.parseIdpMetadata)
// ---------------------------------------------------------------------------

const IDP_METADATA = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example/saml/metadata">
  <IDPSSODescriptor WantAuthnRequestsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/saml/sso"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/saml/sso/post"/>
  </IDPSSODescriptor>
</EntityDescriptor>`;

test("parseIdpMetadata extracts the entityID and per-binding SSO locations", () => {
  const idp = parseIdpMetadata(IDP_METADATA);
  expect(idp.getEntityID()).toBe("https://idp.example/saml/metadata");
  expect(idp.getSingleSignOnService("redirect")).toBe("https://idp.example/saml/sso");
  expect(idp.getSingleSignOnService("post")).toBe("https://idp.example/saml/sso/post");
  expect(idp.isWantAuthnRequestsSigned()).toBe(true);
});

test("parseIdpMetadata rejects a DOCTYPE-bearing metadata document", () => {
  const poisoned = `<!DOCTYPE EntityDescriptor><EntityDescriptor entityID="x"/>`;
  expect(() => parseIdpMetadata(poisoned)).toThrow("ERR_XML_DOCTYPE_OR_ENTITY_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Encoding round-trips (encoding.ts) — the HTTP-Redirect binding wire format
// ---------------------------------------------------------------------------

test("base64 encode/decode round-trips a string", () => {
  const message = '<samlp:AuthnRequest ID="_abc"/>';
  const encoded = base64Encode(message);
  expect(base64Decode(encoded)).toBe(message);
});

test("deflate/inflate round-trips a SAML request payload (redirect binding)", () => {
  const message =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `ID="_id123" Version="2.0"/>`;
  const deflated = deflateString(message);
  expect(Array.isArray(deflated)).toBe(true);
  // inflateString expects a base64 string of the raw-DEFLATE bytes.
  const roundTripped = inflateString(base64Encode(deflated));
  expect(roundTripped).toBe(message);
});

// ---------------------------------------------------------------------------
// Additional decrypt rejection paths (xmlenc.decryptAssertion)
// ---------------------------------------------------------------------------

test("decryptAssertion requires a private key", async () => {
  await expect(
    decryptAssertion({
      encryptedAssertionXml: `<x/>`,
      privateKey: "",
    }),
  ).rejects.toThrow("key option is mandatory");
});

test("decryptAssertion rejects a DOCTYPE-bearing encrypted assertion", async () => {
  const poisoned =
    `<!DOCTYPE saml:EncryptedAssertion>` +
    `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"/>`;
  await expect(
    decryptAssertion({
      encryptedAssertionXml: poisoned,
      privateKey: "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----",
    }),
  ).rejects.toThrow("ERR_XML_DOCTYPE_OR_ENTITY_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Validity window at clock-independent boundaries (validator.verifyTime)
//
// verifyTime reads the real `new Date()` (no injectable clock — the audit's
// H16 seam gap), so these use boundaries far enough from "now" that the outcome
// is clock-independent for any plausible wall clock. Sub-second skew-boundary
// behavior remains interop-only.
// ---------------------------------------------------------------------------

test("verifyTime accepts a window that spans a wide range around now", () => {
  expect(verifyTime("2000-01-01T00:00:00Z", "2999-01-01T00:00:00Z")).toBe(true);
});

test("verifyTime rejects an assertion whose NotOnOrAfter is far in the past", () => {
  expect(verifyTime("2000-01-01T00:00:00Z", "2000-01-02T00:00:00Z")).toBe(false);
});

test("verifyTime rejects an assertion whose NotBefore is far in the future", () => {
  expect(verifyTime("2999-01-01T00:00:00Z", "2999-01-02T00:00:00Z")).toBe(false);
});
