/**
 * SAML signing-certificate pinning — fail-closed regression tests.
 *
 * CRITICAL auth-bypass guard (this exact gap previously had no test): when an
 * IdP's pinned signing-certificate list is EMPTY, `verifySignature` must NOT
 * fall back to a certificate embedded in the assertion itself. Trusting the
 * assertion's own `<X509Certificate>` lets a self-signed forgery verify against
 * itself. The hardened engine fails closed with `NO_SELECTED_CERTIFICATE`
 * whether the empty list arrives as `[]` or `null`, and still rejects a pinned
 * list that does not match the assertion's embedded certificate.
 *
 * These are pure/offline: the fail-closed decision is made before any crypto,
 * so no real key material or signature is required to exercise it.
 */

import { verifySignature } from "@robelest/convex-auth/server/connection/saml/signature";
import type { SamlMetadata } from "@robelest/convex-auth/server/connection/saml/metadata";
import { expect, test } from "vite-plus/test";

const NS = `xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`;

/**
 * A SAML Response whose assertion is signed and carries its OWN embedded
 * certificate (`FORGED-SELF-SIGNED-CERT`) — the shape an attacker uses to try to
 * make an assertion verify against a certificate of their choosing.
 */
const forgedSelfSignedResponse = `<samlp:Response ${NS}>
  <saml:Assertion ID="_forged" Version="2.0">
    <saml:Issuer>https://attacker.example/entity</saml:Issuer>
    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
      <ds:SignedInfo>
        <ds:Reference URI="#_forged"><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>
      </ds:SignedInfo>
      <ds:SignatureValue>ZZZZ</ds:SignatureValue>
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>FORGEDSELFSIGNEDCERT</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </ds:Signature>
  </saml:Assertion>
</samlp:Response>`;

/** Build a minimal {@link SamlMetadata} stub whose signing cert list is `certs`. */
function metadataWithSigningCerts(certs: string | string[] | null): SamlMetadata {
  return {
    xmlString: "",
    getEntityID: () => "https://idp.example/entity",
    getX509Certificate: (use) => (use === "signing" ? certs : null),
    getNameIDFormat: () => [],
    getSingleLogoutService: () => "",
  };
}

const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

test("verifySignature fails closed when the pinned signing-cert list is EMPTY ([])", async () => {
  // Regression: previously the pin check was gated on `metadataCert.length >= 1`,
  // so an empty list skipped the check and verified against the assertion's own
  // embedded cert (self-signed bypass). It must now reject before any crypto.
  await expect(
    verifySignature(forgedSelfSignedResponse, {
      metadata: metadataWithSigningCerts([]),
      signatureAlgorithm: RSA_SHA256,
    }),
  ).rejects.toThrow("NO_SELECTED_CERTIFICATE");
});

test("verifySignature fails closed when the IdP declares no signing cert (null)", async () => {
  await expect(
    verifySignature(forgedSelfSignedResponse, {
      metadata: metadataWithSigningCerts(null),
      signatureAlgorithm: RSA_SHA256,
    }),
  ).rejects.toThrow("NO_SELECTED_CERTIFICATE");
});

test("verifySignature still rejects an embedded cert that does not match the pinned list", async () => {
  // Guards that the fix did not weaken the existing pin-mismatch rejection: a
  // non-empty pinned list that does not contain the assertion's embedded cert
  // must throw the unmatch error (never trust the embedded cert).
  await expect(
    verifySignature(forgedSelfSignedResponse, {
      metadata: metadataWithSigningCerts("PINNEDSIGNINGCERT"),
      signatureAlgorithm: RSA_SHA256,
    }),
  ).rejects.toThrow("ERROR_UNMATCH_CERTIFICATE_DECLARATION_IN_METADATA");
});
