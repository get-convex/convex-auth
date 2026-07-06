import { safeParseXml } from "./api";
import { pkcs1ToPkcs8, pemToDer as samlCryptoPemToDer } from "./crypto";
import { SelectedValue, evaluateXPathToNodes } from "./dom/select";
import { decodeBase64, encodeBase64 } from "@oslojs/encoding";
import { toUtf8String } from "./encoding";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const XMLENC_NS = "http://www.w3.org/2001/04/xmlenc#";

const DATA_ALGORITHMS: {
  [key: string]: {
    mode: "AES-CBC" | "AES-GCM";
    keyBytes: number;
    ivBytes: number;
  };
} = {
  "http://www.w3.org/2001/04/xmlenc#aes128-cbc": {
    mode: "AES-CBC",
    keyBytes: 16,
    ivBytes: 16,
  },
  "http://www.w3.org/2001/04/xmlenc#aes256-cbc": {
    mode: "AES-CBC",
    keyBytes: 32,
    ivBytes: 16,
  },
  "http://www.w3.org/2009/xmlenc11#aes128-gcm": {
    mode: "AES-GCM",
    keyBytes: 16,
    ivBytes: 12,
  },
  "http://www.w3.org/2009/xmlenc11#aes256-gcm": {
    mode: "AES-GCM",
    keyBytes: 32,
    ivBytes: 12,
  },
};

const KEY_ALGORITHMS = {
  RSA_OAEP_MGF1P: "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p",
};

/** Inputs for {@link encryptAssertion}. */
export interface EncryptAssertionOptions {
  assertionXml: string;
  publicKeyPem: string;
  certificate: string;
  encryptionAlgorithm: string;
  keyEncryptionAlgorithm: string;
}

/** Inputs for {@link decryptAssertion}. */
export interface DecryptAssertionOptions {
  encryptedAssertionXml: string;
  privateKey: string | Uint8Array;
}

function selectNodes(expression: string, source: Element | Document): SelectedValue[] {
  return evaluateXPathToNodes(expression, source);
}

function isElement(value: SelectedValue | null | undefined): value is Element {
  return typeof value === "object" && value !== null && value.nodeType === 1;
}

function firstElement(expression: string, source: Element | Document): Element | undefined {
  const node = selectNodes(expression, source)[0];
  return isElement(node) ? node : undefined;
}

function hasWebCrypto(): boolean {
  return !!(globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.getRandomValues);
}

function getSubtleCrypto(): SubtleCrypto {
  if (!hasWebCrypto()) {
    throw new Error("ERR_WEBCRYPTO_NOT_AVAILABLE");
  }
  return globalThis.crypto.subtle;
}

function randomBytes(length: number): Uint8Array {
  if (!hasWebCrypto()) {
    throw new Error("ERR_WEBCRYPTO_NOT_AVAILABLE");
  }
  const output = new Uint8Array(length);
  globalThis.crypto.getRandomValues(output);
  return output;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function toBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

function fromBase64(input: string): Uint8Array {
  return decodeBase64(input.replace(/\s+/g, ""));
}

function normalizeCertificateBody(certificate: string): string {
  return certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

function normalizePemContent(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
}

function pemToDer(pem: string): Uint8Array {
  return fromBase64(normalizePemContent(pem));
}

function uint8ArrayToArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.byteLength);
  out.set(input);
  return out.buffer;
}

async function importRsaOaepPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  const der = pemToDer(publicKeyPem);
  return subtle.importKey(
    "spki",
    uint8ArrayToArrayBuffer(der),
    {
      name: "RSA-OAEP",
      hash: "SHA-1",
    },
    false,
    ["encrypt"],
  );
}

async function importRsaOaepPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  let pkcs8: Uint8Array;
  if (privateKeyPem.includes("BEGIN RSA PRIVATE KEY")) {
    pkcs8 = pkcs1ToPkcs8(privateKeyPem);
  } else {
    pkcs8 = samlCryptoPemToDer(privateKeyPem);
  }
  return subtle.importKey(
    "pkcs8",
    uint8ArrayToArrayBuffer(pkcs8),
    {
      name: "RSA-OAEP",
      hash: "SHA-1",
    },
    false,
    ["decrypt"],
  );
}

async function wrapSymmetricKey(
  symmetricKey: Uint8Array,
  publicKeyPem: string,
  keyEncryptionAlgorithm: string,
): Promise<Uint8Array> {
  if (keyEncryptionAlgorithm === KEY_ALGORITHMS.RSA_OAEP_MGF1P) {
    const subtle = getSubtleCrypto();
    const publicKey = await importRsaOaepPublicKey(publicKeyPem);
    const encrypted = await subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      uint8ArrayToArrayBuffer(symmetricKey),
    );
    return new Uint8Array(encrypted);
  }

  throw new Error(`ERR_KEY_ENCRYPTION_ALGORITHM_NOT_SUPPORTED: ${keyEncryptionAlgorithm}`);
}

async function unwrapSymmetricKey(
  encryptedKey: Uint8Array,
  privateKeyPem: string,
  keyEncryptionAlgorithm: string,
): Promise<Uint8Array> {
  if (keyEncryptionAlgorithm === KEY_ALGORITHMS.RSA_OAEP_MGF1P) {
    const subtle = getSubtleCrypto();
    const privateKey = await importRsaOaepPrivateKey(privateKeyPem);
    const decrypted = await subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      uint8ArrayToArrayBuffer(encryptedKey),
    );
    return new Uint8Array(decrypted);
  }

  throw new Error(`ERR_KEY_ENCRYPTION_ALGORITHM_NOT_SUPPORTED: ${keyEncryptionAlgorithm}`);
}

async function encryptAes(
  content: Uint8Array,
  symmetricKey: Uint8Array,
  mode: "AES-CBC" | "AES-GCM",
  iv: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtleCrypto();
  const key = await subtle.importKey(
    "raw",
    uint8ArrayToArrayBuffer(symmetricKey),
    { name: mode },
    false,
    ["encrypt"],
  );
  const params =
    mode === "AES-GCM"
      ? ({ name: "AES-GCM", iv, tagLength: 128 } as AesGcmParams)
      : ({ name: "AES-CBC", iv } as AesCbcParams);

  const encrypted = await subtle.encrypt(params, key, uint8ArrayToArrayBuffer(content));
  return new Uint8Array(encrypted);
}

async function decryptAes(
  encrypted: Uint8Array,
  symmetricKey: Uint8Array,
  mode: "AES-CBC" | "AES-GCM",
  iv: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtleCrypto();
  const key = await subtle.importKey(
    "raw",
    uint8ArrayToArrayBuffer(symmetricKey),
    { name: mode },
    false,
    ["decrypt"],
  );
  const params =
    mode === "AES-GCM"
      ? ({ name: "AES-GCM", iv, tagLength: 128 } as AesGcmParams)
      : ({ name: "AES-CBC", iv } as AesCbcParams);

  const decrypted = await subtle.decrypt(params, key, uint8ArrayToArrayBuffer(encrypted));
  return new Uint8Array(decrypted);
}

function getRequiredAttrValue(node: Element | null | undefined, attrName: string): string {
  if (!node) {
    throw new Error(`ERR_MISSING_XML_NODE_FOR_ATTRIBUTE: ${attrName}`);
  }
  const value = node.getAttribute(attrName);
  if (!value) {
    throw new Error(`ERR_MISSING_XML_ATTRIBUTE: ${attrName}`);
  }
  return value;
}

function getCipherValueText(node: Element): string {
  const cipherNode = selectNodes(
    "./*[local-name(.)='CipherData']/*[local-name(.)='CipherValue']",
    node,
  )[0];
  if (!isElement(cipherNode) || typeof cipherNode.textContent !== "string") {
    throw new Error("ERR_MISSING_CIPHER_VALUE");
  }
  return cipherNode.textContent;
}

function resolveEncryptedDataNode(doc: Document): Element {
  const encryptedDataNode = selectNodes("//*[local-name(.)='EncryptedData']", doc)[0];
  if (!isElement(encryptedDataNode)) {
    throw new Error("ERR_MISSING_ENCRYPTED_DATA");
  }
  return encryptedDataNode;
}

function resolveEncryptedKeyNode(
  doc: Document,
  encryptedDataNode: Element,
): {
  keyEncryptionAlgorithm: string;
  encryptedKey: Uint8Array;
} {
  const keyInfoNode = firstElement("./*[local-name(.)='KeyInfo']", encryptedDataNode);
  if (!keyInfoNode) {
    throw new Error("cant find encryption algorithm");
  }

  let encryptedKeyContainer = firstElement("./*[local-name(.)='EncryptedKey']", keyInfoNode);

  if (!encryptedKeyContainer) {
    const keyRetrievalMethod = firstElement("./*[local-name(.)='RetrievalMethod']", keyInfoNode);
    const retrievalMethodUri = keyRetrievalMethod ? keyRetrievalMethod.getAttribute("URI") : null;
    if (retrievalMethodUri && retrievalMethodUri.indexOf("#") === 0) {
      const keyId = retrievalMethodUri.substring(1);
      if (!/^[A-Za-z0-9_.:-]+$/.test(keyId)) {
        throw new Error("ERR_INVALID_RETRIEVAL_METHOD_URI");
      }
      encryptedKeyContainer = firstElement(
        `//*[local-name(.)='EncryptedKey' and @Id='${keyId}']`,
        doc,
      );
    }
  }

  if (!encryptedKeyContainer) {
    encryptedKeyContainer = firstElement(".//*[local-name(.)='EncryptedKey']", keyInfoNode);
  }

  if (!encryptedKeyContainer) {
    throw new Error("cant find encryption algorithm");
  }

  const keyEncMethodNode =
    firstElement("./*[local-name(.)='EncryptionMethod']", encryptedKeyContainer) ||
    firstElement(".//*[local-name(.)='EncryptionMethod']", encryptedKeyContainer);

  if (!keyEncMethodNode) {
    throw new Error("cant find encryption algorithm");
  }

  const keyEncryptionAlgorithm = getRequiredAttrValue(keyEncMethodNode, "Algorithm");
  const encryptedKeyNode =
    firstElement(
      "./*[local-name(.)='CipherData']/*[local-name(.)='CipherValue']",
      encryptedKeyContainer,
    ) ||
    firstElement(
      ".//*[local-name(.)='CipherData']/*[local-name(.)='CipherValue']",
      encryptedKeyContainer,
    );

  if (!encryptedKeyNode || typeof encryptedKeyNode.textContent !== "string") {
    throw new Error("ERR_MISSING_ENCRYPTED_KEY");
  }

  return {
    keyEncryptionAlgorithm,
    encryptedKey: fromBase64(encryptedKeyNode.textContent),
  };
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Encrypt a SAML assertion into an `<xenc:EncryptedData>` element.
 *
 * Generates a random AES content key (wrapped with the recipient's RSA public
 * key) and AES-encrypts the assertion XML.
 */
export async function encryptAssertion(opts: EncryptAssertionOptions): Promise<string> {
  const { assertionXml, publicKeyPem, certificate, encryptionAlgorithm, keyEncryptionAlgorithm } =
    opts;

  if (!assertionXml) {
    throw new Error("must provide content to encrypt");
  }
  if (!publicKeyPem) {
    throw new Error("rsa_pub option is mandatory and you should provide a valid RSA public key");
  }
  if (!certificate) {
    throw new Error(
      "pem option is mandatory and you should provide a valid x509 certificate encoded as PEM",
    );
  }

  const dataAlg = DATA_ALGORITHMS[encryptionAlgorithm];
  if (!dataAlg) {
    throw new Error(`encryption algorithm not supported: ${encryptionAlgorithm}`);
  }

  const symmetricKey = randomBytes(dataAlg.keyBytes);
  const iv = randomBytes(dataAlg.ivBytes);
  const contentBytes = utf8Encoder.encode(assertionXml);

  const encryptedContent = await encryptAes(contentBytes, symmetricKey, dataAlg.mode, iv);

  const encryptedPayload = concatBytes(iv, encryptedContent);
  const encryptedKey = await wrapSymmetricKey(symmetricKey, publicKeyPem, keyEncryptionAlgorithm);
  const certBody = normalizeCertificateBody(certificate);

  return (
    `<xenc:EncryptedData Type="http://www.w3.org/2001/04/xmlenc#Element" xmlns:xenc="${XMLENC_NS}">` +
    `<xenc:EncryptionMethod Algorithm="${escapeXmlText(encryptionAlgorithm)}" />` +
    `<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `<e:EncryptedKey xmlns:e="${XMLENC_NS}">` +
    `<e:EncryptionMethod Algorithm="${escapeXmlText(keyEncryptionAlgorithm)}">` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1" />` +
    `</e:EncryptionMethod>` +
    `<KeyInfo>` +
    `<X509Data><X509Certificate>${escapeXmlText(certBody)}</X509Certificate></X509Data>` +
    `</KeyInfo>` +
    `<e:CipherData>` +
    `<e:CipherValue>${toBase64(encryptedKey)}</e:CipherValue>` +
    `</e:CipherData>` +
    `</e:EncryptedKey>` +
    `</KeyInfo>` +
    `<xenc:CipherData>` +
    `<xenc:CipherValue>${toBase64(encryptedPayload)}</xenc:CipherValue>` +
    `</xenc:CipherData>` +
    `</xenc:EncryptedData>`
  );
}

/**
 * Decrypt an `<xenc:EncryptedData>` assertion produced by {@link encryptAssertion}.
 *
 * Unwraps the AES content key with the SP's RSA private key, then AES-decrypts
 * the assertion XML.
 */
export async function decryptAssertion(opts: DecryptAssertionOptions): Promise<string> {
  const { encryptedAssertionXml, privateKey } = opts;

  if (!encryptedAssertionXml) {
    throw new Error("must provide XML to encrypt");
  }

  const privateKeyPem = toUtf8String(privateKey);
  if (!privateKeyPem) {
    throw new Error("key option is mandatory and you should provide a valid RSA private key");
  }

  const doc = safeParseXml(encryptedAssertionXml, "text/xml");
  const encryptedDataNode = resolveEncryptedDataNode(doc);

  const dataEncMethodNode = firstElement(
    "./*[local-name(.)='EncryptionMethod']",
    encryptedDataNode,
  );
  const encryptionAlgorithm = getRequiredAttrValue(dataEncMethodNode, "Algorithm");

  const dataAlg = DATA_ALGORITHMS[encryptionAlgorithm];
  // Only authenticated AES-GCM is accepted on the decrypt path. AES-CBC is
  // unauthenticated and malleable, which exposes a padding/decryption oracle
  // (Jager–Somorovsky) when an attacker submits crafted EncryptedAssertion
  // ciphertexts; refusing it removes the oracle entirely.
  if (!dataAlg || dataAlg.mode !== "AES-GCM") {
    throw new Error("ERR_UNSUPPORTED_DATA_ENCRYPTION_ALGORITHM");
  }

  const keyInfo = resolveEncryptedKeyNode(doc, encryptedDataNode);
  const keyEncryptionAlgorithm = keyInfo.keyEncryptionAlgorithm;
  const encryptedKey = keyInfo.encryptedKey;
  const symmetricKey = await unwrapSymmetricKey(
    encryptedKey,
    privateKeyPem,
    keyEncryptionAlgorithm,
  );

  const encryptedContent = fromBase64(getCipherValueText(encryptedDataNode));

  if (encryptedContent.length < dataAlg.ivBytes) {
    throw new Error("ERR_INVALID_ENCRYPTED_CONTENT");
  }

  const iv = encryptedContent.slice(0, dataAlg.ivBytes);
  const payload = encryptedContent.slice(dataAlg.ivBytes);

  const decrypted = await decryptAes(payload, symmetricKey, dataAlg.mode, iv);

  const result = utf8Decoder.decode(decrypted);
  if (!result) {
    throw new Error("ERR_UNDEFINED_ENCRYPTED_ASSERTION");
  }

  return result;
}
