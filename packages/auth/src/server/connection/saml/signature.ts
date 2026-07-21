import { decodeBase64, encodeBase64 } from "@oslojs/encoding";
import {
  readPrivateKey,
  base64Encode,
  normalizeCerString,
  flattenDeep,
  toUtf8String,
} from "./encoding";
import { rsaSign, rsaVerify, getPublicKeyPemFromCert } from "./crypto";
import { SignatureAlgorithm, DIGEST_BY_SIGNATURE } from "./constants";
import {
  createSignedXml,
  constructMessageSignature as constructMessageSignatureXmlDsig,
  constructSamlSignature as constructSamlSignatureXmlDsig,
  verifyMessageSignature as verifyMessageSignatureXmlDsig,
  schemeToHash,
} from "./xmldsig";
import { getContext } from "./api";
import {
  selectXPath as select,
  type SelectedValue,
  isElementNode,
  isTextNode,
  serializeXmlNode,
} from "./dom/select";
import type { SignatureConfig } from "./types";
import type { SamlMetadata } from "./metadata";

interface SignatureConstructor {
  rawSamlMessage: string;
  referenceTagXPath?: string;
  privateKey: string;
  privateKeyPass?: string;
  signatureAlgorithm: string;
  signingCert: string | Uint8Array;
  isBase64Output?: boolean;
  signatureConfig?: SignatureConfig;
  isMessageSigned?: boolean;
  transformationAlgorithms?: string[];
}

interface SignatureVerifierOptions {
  metadata?: SamlMetadata;
  keyFile?: string;
  signatureAlgorithm?: string;
}

type KeyUse = "signing" | "encryption";

/** One node in the `xml`-module array representation of a `<KeyDescriptor>`. */
type KeySectionNode =
  | string
  | { _attr: Record<string, string> }
  | { [tag: string]: string | KeySectionNode[] };

/** The `<KeyDescriptor>` section emitted into metadata, as `xml`-module input. */
interface KeyComponent {
  KeyDescriptor: KeySectionNode[];
}

/** Map XML-dsig signature algorithm URIs to node-rsa signing-scheme aliases. */
const nrsaAliasMapping: Record<string, string> = {
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": "pkcs1-sha1",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "pkcs1-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": "pkcs1-sha512",
};

const signatureAlgorithms = SignatureAlgorithm;
const digestAlgorithms = DIGEST_BY_SIGNATURE;

function getDigestMethod(sigAlg: string): string | undefined {
  return (digestAlgorithms as Record<string, string>)[sigAlg];
}

/**
 * Read the text data of an `<X509Certificate>`'s first child, narrowing the
 * XPath result to an element/text node. Mirrors the prior `node.firstChild.data`
 * access; a non-text or missing child yields an empty certificate string, which
 * downstream certificate matching rejects.
 */
function certificateNodeData(node: SelectedValue): string {
  if (isElementNode(node)) {
    const child = node.firstChild;
    if (child !== null && isTextNode(child) && child.data !== null) {
      return child.data;
    }
  }
  return "";
}

function toPemCertificate(certificate: string): string {
  if (certificate.indexOf("BEGIN CERTIFICATE") >= 0) {
    return certificate;
  }
  return `-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----`;
}

function bytesToBinaryString(input: Uint8Array): string {
  let output = "";
  for (const byte of input) {
    output += String.fromCodePoint(byte);
  }
  return output;
}

/** Construct the XML signature for POST binding, returning a base64-encoded string. */
export async function constructSamlSignature(opts: SignatureConstructor): Promise<string> {
  return constructSamlSignatureXmlDsig({
    ...opts,
    signatureAlgorithm: opts.signatureAlgorithm || signatureAlgorithms.RSA_SHA256,
    getDigestMethod,
    getKeyInfo,
    readPrivateKey: (keyString, passphrase, isOutputString) =>
      readPrivateKey(keyString, passphrase, isOutputString),
    base64Encode: base64Encode,
  });
}

/**
 * Verify the XML signature.
 *
 * Hardened against XML Signature Wrapping (XSW): signatures are located with
 * absolute XPaths rather than by naively fetching the first `Signature`
 * element, and any signature/assertion smuggled inside
 * `SubjectConfirmationData` is rejected as a potential wrapping attack.
 *
 * Per SAML core 5.4.2 (References): a SAML assertion or protocol message
 * being signed MUST carry an ID on its root element, and the signature MUST
 * contain a single `<ds:Reference>` whose URI is a same-document reference
 * to that ID (e.g. `#foo` for ID `foo`). Only references that actually
 * passed verification are returned, so the assertion handed back is
 * cryptographically authenticated rather than merely present in the document.
 *
 * Fails closed: a failed assertion signature aborts immediately rather than
 * falling through to another candidate. When `opts.metadata` is supplied,
 * the response's X509 certificate is pinned to one declared in metadata
 * (supporting rolling certificate usage). If metadata declares no signing
 * certificate, verification is rejected (`NO_SELECTED_CERTIFICATE`) rather than
 * trusting a certificate embedded in the assertion itself — a self-signed forgery
 * must never be allowed to verify against its own bundled certificate.
 *
 * Returns a tuple where the first element is `true` if the signature is valid,
 * and the second is the cryptographically authenticated assertion node as a
 * string, or `null` if not found.
 */
export async function verifySignature(
  xml: string,
  opts: SignatureVerifierOptions,
): Promise<[boolean, string | null]> {
  const { dom } = getContext();
  const doc = dom!.parseFromString(xml);

  const { dom: docParser } = getContext();
  const messageSignatureXpath =
    "/*[contains(local-name(), 'Response') or contains(local-name(), 'Request')]/*[local-name(.)='Signature']";
  const assertionSignatureXpath =
    "/*[contains(local-name(), 'Response') or contains(local-name(), 'Request')]/*[local-name(.)='Assertion']/*[local-name(.)='Signature']";
  const wrappingElementsXPath =
    "/*[contains(local-name(), 'Response')]/*[local-name(.)='Assertion']/*[local-name(.)='Subject']/*[local-name(.)='SubjectConfirmation']/*[local-name(.)='SubjectConfirmationData']//*[local-name(.)='Assertion' or local-name(.)='Signature']";

  let selection: SelectedValue[] = [];
  const messageSignatureNode = select(messageSignatureXpath, doc);
  const assertionSignatureNode = select(assertionSignatureXpath, doc);
  const wrappingElementNode = select(wrappingElementsXPath, doc);

  selection = selection.concat(assertionSignatureNode);
  selection = selection.concat(messageSignatureNode);

  if (wrappingElementNode.length !== 0) {
    throw new Error("ERR_POTENTIAL_WRAPPING_ATTACK");
  }

  if (selection.length === 0) {
    return [false, null];
  }

  for (const signatureNode of selection) {
    if (!isElementNode(signatureNode)) {
      continue;
    }
    const isAssertionSignature = assertionSignatureNode.includes(signatureNode);
    const sig = createSignedXml();
    let verified = false;

    sig.signatureAlgorithm = opts.signatureAlgorithm!;

    if (!opts.keyFile && !opts.metadata) {
      throw new Error("ERR_UNDEFINED_SIGNATURE_VERIFIER_OPTIONS");
    }

    if (opts.keyFile) {
      const { readFile } = getContext();
      if (!readFile) {
        throw new Error("ERR_FILE_IO_NOT_AVAILABLE");
      }
      sig.publicCert = toUtf8String(readFile(opts.keyFile));
    }

    if (opts.metadata) {
      const certificateNode = select(".//*[local-name(.)='X509Certificate']", signatureNode);
      let metadataCertList: string | unknown[] | null = opts.metadata.getX509Certificate("signing");
      if (Array.isArray(metadataCertList)) {
        metadataCertList = flattenDeep(metadataCertList);
      } else if (typeof metadataCertList === "string") {
        metadataCertList = [metadataCertList];
      } else {
        metadataCertList = [];
      }
      /**
       * `flattenDeep` is deliberately loose (`unknown[]`); IdP metadata only ever
       * yields PEM strings here, which `normalizeCerString` accepts. A missing
       * (`null`) or empty list is normalized to `[]` above so the fail-closed
       * guard below throws a clean `NO_SELECTED_CERTIFICATE` instead of a raw
       * `TypeError`.
       */
      const metadataCert: string[] = (metadataCertList as Array<string | Uint8Array>).map(
        normalizeCerString,
      );

      /**
       * Fail CLOSED: without at least one pinned signing certificate from IdP
       * metadata there is no trust anchor. NEVER fall back to an
       * `<X509Certificate>` embedded in the assertion — trusting the assertion's
       * own certificate lets a self-signed forgery verify against itself (auth
       * bypass). Reject whether or not the assertion carries an embedded cert.
       */
      if (metadataCert.length === 0) {
        throw new Error("NO_SELECTED_CERTIFICATE");
      }

      if (certificateNode.length !== 0) {
        const x509CertificateData = certificateNodeData(certificateNode[0]);
        const x509Certificate = normalizeCerString(x509CertificateData);

        if (!metadataCert.find((cert) => cert.trim() === x509Certificate.trim())) {
          throw new Error("ERROR_UNMATCH_CERTIFICATE_DECLARATION_IN_METADATA");
        }

        sig.publicCert = getKeyInfo(x509Certificate).getKey();
      } else {
        sig.publicCert = getKeyInfo(metadataCert[0]).getKey();
      }
    }

    sig.loadSignature(signatureNode);

    verified = await sig.checkSignature(serializeXmlNode(doc));

    if (!verified) {
      if (isAssertionSignature) {
        throw new Error("ERR_FAILED_TO_VERIFY_ASSERTION_SIGNATURE");
      }
      continue;
    }
    if (!(sig.getSignedReferences().length >= 1)) {
      throw new Error("NO_SIGNATURE_REFERENCES");
    }
    const signedVerifiedXML = sig.getSignedReferences()[0];
    const rootNode = docParser!.parseFromString(signedVerifiedXML).documentElement;
    if (rootNode.localName === "Response") {
      const assertions = select("./*[local-name()='Assertion']", rootNode);

      const encryptedAssertions = select("./*[local-name()='EncryptedAssertion']", rootNode);
      if (assertions.length === 1) {
        return [true, serializeXmlNode(assertions[0])];
      } else if (encryptedAssertions.length >= 1) {
        return [true, serializeXmlNode(rootNode)];
      } else {
        return [true, null];
      }
    } else if (rootNode.localName === "Assertion") {
      return [true, serializeXmlNode(rootNode)];
    } else {
      return [true, null];
    }
  }
  return [false, null];
}

/** Create the key section in metadata (an abstraction shared by signing and encryption use). */
export function createKeySection(use: KeyUse, certString: string | Uint8Array): KeyComponent {
  return {
    ["KeyDescriptor"]: [
      {
        _attr: { use },
      },
      {
        ["ds:KeyInfo"]: [
          {
            _attr: {
              "xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
            },
          },
          {
            ["ds:X509Data"]: [
              {
                "ds:X509Certificate": normalizeCerString(certString),
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Construct the message signature (octet-string signature) used by the redirect binding. */
export async function constructMessageSignature(
  octetString: string,
  key: string,
  passphrase?: string,
  isBase64?: boolean,
  signingAlgorithm?: string,
): Promise<string> {
  return constructMessageSignatureXmlDsig({
    octetString,
    key,
    passphrase,
    isBase64,
    signingAlgorithm,
    nrsaAliasMapping,
    defaultSignatureAlgorithm: signatureAlgorithms.RSA_SHA1,
    readPrivateKey: (keyString, keyPassphrase, isOutputString) =>
      readPrivateKey(keyString, keyPassphrase, isOutputString),
    signMessage: async ({ octetString: source, privateKey, signingScheme, isBase64Output }) => {
      const privateKeyPem =
        typeof privateKey === "string" ? privateKey : new TextDecoder().decode(privateKey);
      const hash = schemeToHash(signingScheme);
      const sigB64 = await rsaSign(privateKeyPem, source, hash);
      if (isBase64Output) return sigB64;
      return bytesToBinaryString(decodeBase64(sigB64));
    },
  });
}

/** Verify a message signature against the identity/service provider's signing certificate. */
export async function verifyMessageSignature(
  metadata: SamlMetadata,
  octetString: string,
  signature: string | Uint8Array,
  verifyAlgorithm?: string,
): Promise<boolean> {
  /**
   * `getX509Certificate` is declared `string | string[] | null` for callers that
   * handle rolling certificates, but the signing certificate consumed here is a
   * single PEM string; the downstream verifier and prior `any` typing assume so.
   */
  const signCert = metadata.getX509Certificate("signing") as string;
  return verifyMessageSignatureXmlDsig({
    octetString,
    signature,
    signCert,
    verifyAlgorithm,
    nrsaAliasMapping,
    defaultSignatureAlgorithm: signatureAlgorithms.RSA_SHA1,
    getPublicKeyPemFromCertificate: getPublicKeyPemFromCert,
    verifyMessage: async ({
      octetString: source,
      signature: incomingSignature,
      publicKey,
      signingScheme,
    }) => {
      const hash = schemeToHash(signingScheme);
      let sigBase64: string;
      if (typeof incomingSignature === "string") {
        sigBase64 = incomingSignature;
      } else {
        sigBase64 = encodeBase64(incomingSignature);
      }
      let certOrKey = publicKey;
      if (publicKey.indexOf("BEGIN CERTIFICATE") < 0 && publicKey.indexOf("BEGIN PUBLIC KEY") < 0) {
        certOrKey = toPemCertificate(publicKey);
      }
      return rsaVerify(certOrKey, source, sigBase64, hash);
    },
  });
}

/** Build the `<KeyInfo>`/public-key accessors for an X509 certificate string. */
export function getKeyInfo(x509Certificate: string, signatureConfig: SignatureConfig = {}) {
  const prefix = signatureConfig.prefix ? `${signatureConfig.prefix}:` : "";
  return {
    getKeyInfo: () => {
      return `<${prefix}X509Data><${prefix}X509Certificate>${x509Certificate}</${prefix}X509Certificate></${prefix}X509Data>`;
    },
    getKey: () => {
      return getPublicKeyPemFromCert(x509Certificate).toString();
    },
  };
}
