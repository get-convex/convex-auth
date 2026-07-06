import { safeParseXml } from "./api";
import { CanonicalNode, CanonicalizationOptions, getTransformByAlgorithm } from "./c14n";
import { sha1Base64, sha256Base64, rsaSign, rsaVerify } from "./crypto";
import { SelectedValue, evaluateXPathToNodes, serializeXmlNode } from "./dom/select";
import { toUtf8String } from "./encoding";

/** A value usable as bytes: a string or a `Uint8Array`. */
export type BinaryLike = string | Uint8Array;

/** Inputs to a low-level message-signing callback. */
export interface MessageSignerOptions {
  octetString: string;
  privateKey: BinaryLike;
  signingScheme: string;
  isBase64Output: boolean;
}

/** Inputs to a low-level message-verification callback. */
export interface MessageVerifierOptions {
  octetString: string;
  signature: BinaryLike;
  publicKey: string;
  signingScheme: string;
}

/** Options for {@link constructMessageSignature}. */
export interface ConstructMessageSignatureOptions {
  octetString: string;
  key: string;
  passphrase?: string;
  isBase64?: boolean;
  signingAlgorithm?: string;
  nrsaAliasMapping: { [key: string]: string };
  defaultSignatureAlgorithm: string;
  readPrivateKey: (
    keyString: BinaryLike,
    passphrase: string | undefined,
    isOutputString?: boolean,
  ) => BinaryLike;
  signMessage: (opts: MessageSignerOptions) => Promise<string | Uint8Array>;
}

/** Options for {@link verifyMessageSignature}. */
export interface VerifyMessageSignatureOptions {
  octetString: string;
  signature: BinaryLike;
  signCert: string;
  verifyAlgorithm?: string;
  nrsaAliasMapping: { [key: string]: string };
  defaultSignatureAlgorithm: string;
  getPublicKeyPemFromCertificate: (x509Certificate: string) => string;
  verifyMessage: (opts: MessageVerifierOptions) => Promise<boolean>;
}

/** Options for {@link constructSamlSignature}. */
export interface ConstructSamlSignatureOptions {
  rawSamlMessage: string;
  referenceTagXPath?: string;
  privateKey: string;
  privateKeyPass?: string;
  signatureAlgorithm: string;
  signingCert: BinaryLike;
  isBase64Output?: boolean;
  signatureConfig?: ComputeSignatureOptions;
  isMessageSigned?: boolean;
  transformationAlgorithms?: string[];
  getDigestMethod: (sigAlg: string) => string | undefined;
  getKeyInfo: (
    x509Certificate: string,
    signatureConfig?: ComputeSignatureOptions,
  ) => { getKeyInfo: () => string; getKey: () => string };
  readPrivateKey: (
    keyString: BinaryLike,
    passphrase: string | undefined,
    isOutputString?: boolean,
  ) => BinaryLike;
  base64Encode: (message: string | number[]) => string;
}

interface XmlSignatureAlgorithm {
  getSignature: (signedInfo: string, privateKey: string) => Promise<string>;
  verifySignature: (material: string, key: string, signatureValue: string) => Promise<boolean>;
  getAlgorithmName: () => string;
}

interface XmlHashAlgorithm {
  getHash: (xml: string) => string;
  getAlgorithmName: () => string;
}

interface XmlReference {
  xpath?: string;
  transforms: string[];
  digestAlgorithm: string;
  uri?: string;
  digestValue?: string;
  inclusiveNamespacesPrefixList: string[];
  isEmptyUri: boolean;
  ancestorNamespaces?: Array<{ prefix: string; namespaceURI: string }>;
  signedReference?: string;
  validationError?: Error;
}

interface ComputeSignatureOptions {
  prefix?: string;
  attrs?: { [key: string]: string };
  location?: {
    reference?: string;
    action?: "append" | "prepend" | "before" | "after";
  };
  existingPrefixes?: { [key: string]: string };
}

function selectNodes(expression: string, source: Node): SelectedValue[] {
  /**
   * The XPath engine descends from an `Element` or `Document`; every `source`
   * passed here is one of those at runtime (a parsed signature document or an
   * element selected from one). This bridges the nominal `Node` supertype to the
   * engine's `Element | Document` container across the xmldom/global-DOM boundary.
   */
  return evaluateXPathToNodes(expression, source as Element | Document);
}

function normalizePem(pem: string): string {
  return `${(
    pem
      .trim()
      .replace(/(\r\n|\r)/g, "\n")
      .match(/.{1,64}/g) || []
  ).join("\n")}\n`;
}

function derToPem(derBase64: string, pemLabel: string): string {
  const cleaned = derBase64.replace(/(\r\n|\r|\n)/g, "").trim();
  const pem = `-----BEGIN ${pemLabel}-----\n${cleaned}\n-----END ${pemLabel}-----`;
  return normalizePem(pem);
}

function normalizeCertificateBody(raw: string): string {
  return raw
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
}

/**
 * Map a signature-scheme name or algorithm URI to its WebCrypto hash.
 *
 * Accepts the `pkcs1-sha1` / `pkcs1-sha256` short-hands as well as `sha-256`,
 * defaulting to SHA-1 when nothing matches.
 */
export function schemeToHash(scheme: string): "SHA-1" | "SHA-256" {
  const normalized = scheme.toLowerCase();
  if (normalized.includes("sha256")) return "SHA-256";
  if (normalized.includes("sha1")) return "SHA-1";
  if (normalized.includes("sha-256")) return "SHA-256";
  return "SHA-1";
}

type XmlSelectable = SelectedValue | Node | null | undefined;

function isElementNode(node: XmlSelectable): node is Element {
  return typeof node === "object" && node !== null && node.nodeType === 1;
}

function isAttributeNode(node: XmlSelectable): node is Attr {
  return typeof node === "object" && node !== null && node.nodeType === 2;
}

function isTextNode(node: XmlSelectable): node is Text {
  return typeof node === "object" && node !== null && node.nodeType === 3;
}

function isDocument(node: Node): node is Document {
  return node.nodeType === 9;
}

function findChildren(node: Node, localName: string): Element[] {
  const element: Node = isDocument(node) ? node.documentElement || node : node;
  const res: Element[] = [];
  if (!element.childNodes) {
    return res;
  }
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i);
    if (isElementNode(child) && child.localName === localName) {
      res.push(child);
    }
  }
  return res;
}

function findAttr(element: Element, localName: string, namespace?: string): Attr | null {
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    if (
      attr.localName === localName &&
      (namespace == null ||
        attr.namespaceURI === namespace ||
        (!attr.namespaceURI && element.namespaceURI === namespace))
    ) {
      return attr;
    }
  }
  return null;
}

function isArrayHasLength(input: readonly unknown[]): boolean {
  return Array.isArray(input) && input.length > 0;
}

function getElementNamespaceDeclarations(
  node: Element,
): Array<{ prefix: string; namespaceURI: string }> {
  const out: Array<{ prefix: string; namespaceURI: string }> = [];
  for (let i = 0; i < node.attributes.length; i++) {
    const attr = node.attributes[i];
    if (attr.nodeName.search(/^xmlns:?/) !== -1) {
      out.push({
        prefix: attr.nodeName.replace(/^xmlns:?/, ""),
        namespaceURI: attr.nodeValue || "",
      });
    }
  }
  return out;
}

function findAncestorNs(
  doc: Document,
  docSubsetXpath?: string,
): Array<{ prefix: string; namespaceURI: string }> {
  if (!docSubsetXpath) {
    return [];
  }
  const docSubset = selectNodes(docSubsetXpath, doc);
  if (!isArrayHasLength(docSubset)) {
    return [];
  }
  const first = docSubset[0];
  if (!isElementNode(first)) {
    throw new Error("Document subset must be list of elements");
  }

  const nsList: Array<{ prefix: string; namespaceURI: string }> = [];
  let parent: Node | null = first.parentNode;
  while (parent && isElementNode(parent)) {
    nsList.push(...getElementNamespaceDeclarations(parent));
    parent = parent.parentNode;
  }

  const unique: Array<{ prefix: string; namespaceURI: string }> = [];
  const seen = new Set<string>();
  for (const entry of nsList) {
    if (!seen.has(entry.prefix)) {
      seen.add(entry.prefix);
      unique.push(entry);
    }
  }

  const subsetPrefix = (() => {
    for (let i = 0; i < first.attributes.length; i++) {
      const nodeName = first.attributes[i].nodeName;
      if (nodeName.search(/^xmlns:?/) !== -1) {
        return nodeName.replace(/^xmlns:?/, "");
      }
    }
    return first.prefix || "";
  })();

  return unique.filter((v) => v.prefix !== subsetPrefix);
}

const sha1: XmlHashAlgorithm = {
  getHash(xml: string): string {
    return sha1Base64(xml);
  },

  getAlgorithmName(): string {
    return "http://www.w3.org/2000/09/xmldsig#sha1";
  },
};

const sha256: XmlHashAlgorithm = {
  getHash(xml: string): string {
    return sha256Base64(xml);
  },

  getAlgorithmName(): string {
    return "http://www.w3.org/2001/04/xmlenc#sha256";
  },
};

const rsaSha1: XmlSignatureAlgorithm = {
  async getSignature(signedInfo: string, privateKey: string): Promise<string> {
    return rsaSign(privateKey, signedInfo, "SHA-1");
  },

  async verifySignature(material: string, key: string, signatureValue: string): Promise<boolean> {
    return rsaVerify(key, material, signatureValue, "SHA-1");
  },

  getAlgorithmName(): string {
    return "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
  },
};

const rsaSha256: XmlSignatureAlgorithm = {
  async getSignature(signedInfo: string, privateKey: string): Promise<string> {
    return rsaSign(privateKey, signedInfo, "SHA-256");
  },

  async verifySignature(material: string, key: string, signatureValue: string): Promise<boolean> {
    return rsaVerify(key, material, signatureValue, "SHA-256");
  },

  getAlgorithmName(): string {
    return "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  },
};

const HASH_ALGORITHMS: Record<string, XmlHashAlgorithm> = {
  "http://www.w3.org/2000/09/xmldsig#sha1": sha1,
  "http://www.w3.org/2001/04/xmlenc#sha256": sha256,
};

const SIGNATURE_ALGORITHMS: Record<string, XmlSignatureAlgorithm> = {
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": rsaSha1,
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": rsaSha256,
};

function findHashAlgorithm(name: string): XmlHashAlgorithm {
  const algo = HASH_ALGORITHMS[name];
  if (!algo) {
    throw new Error(`hash algorithm '${name}' is not supported`);
  }
  return algo;
}

function findSignatureAlgorithm(name?: string): XmlSignatureAlgorithm {
  if (!name) {
    throw new Error("signatureAlgorithm is required");
  }
  const algo = SIGNATURE_ALGORITHMS[name];
  if (!algo) {
    throw new Error(`signature algorithm '${name}' is not supported`);
  }
  return algo;
}

const defaultNsForPrefix: { [key: string]: string } = {
  ds: "http://www.w3.org/2000/09/xmldsig#",
};

function staticGetKeyInfoContent({
  publicCert,
  prefix,
}: {
  publicCert?: string;
  prefix?: string;
}): string | null {
  if (!publicCert) {
    return null;
  }
  const currentPrefix = prefix ? `${prefix}:` : "";
  const certBody = normalizeCertificateBody(publicCert);
  if (!certBody) {
    return null;
  }
  return `<${currentPrefix}X509Data><${currentPrefix}X509Certificate>${certBody}</${currentPrefix}X509Certificate></${currentPrefix}X509Data>`;
}

function staticGetCertFromKeyInfo(keyInfo: Node | null): string | null {
  if (!isElementNode(keyInfo)) {
    return null;
  }
  const certNode = selectNodes(".//*[local-name(.)='X509Certificate']", keyInfo)[0];
  if (isElementNode(certNode) && typeof certNode.textContent === "string") {
    return derToPem(certNode.textContent, "CERTIFICATE");
  }
  return null;
}

/** Create a fresh XML-dsig signer/verifier instance. */
export function createSignedXml() {
  const self = {
    signatureAlgorithm: undefined as string | undefined,
    canonicalizationAlgorithm: undefined as string | undefined,
    inclusiveNamespacesPrefixList: [] as string[],
    keyInfoAttributes: {} as { [key: string]: string },
    getKeyInfoContent: (args: { publicCert?: string; prefix?: string }): string | null =>
      staticGetKeyInfoContent(args),
    getCertFromKeyInfo: (keyInfo: Node | null): string | null => staticGetCertFromKeyInfo(keyInfo),

    id: 0,
    signedXml: "",
    signatureXml: "",
    signatureNode: null as Node | null,
    signatureValue: "",
    originalXmlWithIds: "",
    keyInfo: null as Node | null,
    references: [] as XmlReference[],
    signedReferences: [] as string[],

    idAttributes: ["Id", "ID", "id"],
    privateKey: undefined as string | undefined,
    publicCert: undefined as string | undefined,

    addReference({
      xpath,
      transforms,
      digestAlgorithm,
      uri = "",
      digestValue,
      inclusiveNamespacesPrefixList = [],
      isEmptyUri = false,
    }: {
      xpath?: string;
      transforms: string[];
      digestAlgorithm: string;
      uri?: string;
      digestValue?: string;
      inclusiveNamespacesPrefixList?: string[];
      isEmptyUri?: boolean;
    }) {
      if (!digestAlgorithm) {
        throw new Error("digestAlgorithm is required");
      }
      if (!isArrayHasLength(transforms)) {
        throw new Error("transforms must contain at least one transform algorithm");
      }

      self.references.push({
        xpath,
        transforms,
        digestAlgorithm,
        uri,
        digestValue,
        inclusiveNamespacesPrefixList,
        isEmptyUri,
      });
    },

    getSignedReferences(): string[] {
      return [...self.signedReferences];
    },

    getCanonXml(transforms: string[], node: Node, options: CanonicalizationOptions = {}): string {
      options.defaultNsForPrefix = options.defaultNsForPrefix || defaultNsForPrefix;
      options.signatureNode =
        self.signatureNode === null ? undefined : (self.signatureNode as CanonicalNode);

      const canonXml = node.cloneNode(true) as CanonicalNode;
      let transformed: CanonicalNode | string = canonXml;

      transforms.forEach((transformName) => {
        if (typeof transformed !== "string") {
          const transform = getTransformByAlgorithm(transformName);
          transformed = transform.process(transformed, options);
        }
      });

      return typeof transformed === "string"
        ? transformed
        : (transformed as { toString(): string }).toString();
    },

    ensureHasId(node: Element): string {
      for (const idAttr of self.idAttributes) {
        const attr = findAttr(node, idAttr);
        if (attr) {
          return attr.value;
        }
      }
      const id = `_${self.id++}`;
      node.setAttribute("Id", id);
      return id;
    },

    getCanonReferenceXml(doc: Document, ref: XmlReference, node: Node): string {
      if (Array.isArray(ref.transforms)) {
        ref.ancestorNamespaces = findAncestorNs(doc, ref.xpath);
      }

      const c14nOptions: CanonicalizationOptions = {
        inclusiveNamespacesPrefixList: ref.inclusiveNamespacesPrefixList,
        ancestorNamespaces: ref.ancestorNamespaces,
      };

      return self.getCanonXml(ref.transforms, node, c14nOptions);
    },

    getCanonSignedInfoXml(doc: Document): string {
      if (self.signatureNode == null) {
        throw new Error("No signature found.");
      }
      if (typeof self.canonicalizationAlgorithm !== "string") {
        throw new Error("Missing canonicalizationAlgorithm when trying to get signed info for XML");
      }
      const signedInfo = findChildren(self.signatureNode, "SignedInfo");
      if (signedInfo.length === 0) {
        throw new Error("could not find SignedInfo element in the message");
      }
      if (signedInfo.length > 1) {
        throw new Error(
          "could not get canonicalized signed info for a signature that contains multiple SignedInfo nodes",
        );
      }

      const ancestorNamespaces = findAncestorNs(doc, "//*[local-name()='SignedInfo']");
      return self.getCanonXml([self.canonicalizationAlgorithm], signedInfo[0], {
        ancestorNamespaces,
      });
    },

    createReferences(doc: Document, prefix?: string): string {
      const currentPrefix = prefix ? `${prefix}:` : "";
      let res = "";

      for (const ref of self.references) {
        const nodes = selectNodes(ref.xpath || "", doc);
        if (!isArrayHasLength(nodes)) {
          throw new Error(
            `the following xpath cannot be signed because it was not found: ${ref.xpath}`,
          );
        }

        for (const selected of nodes) {
          if (!isElementNode(selected)) {
            continue;
          }
          const node: Element = selected;
          if (ref.isEmptyUri) {
            res += `<${currentPrefix}Reference URI="">`;
          } else {
            const id = self.ensureHasId(node);
            ref.uri = id;
            res += `<${currentPrefix}Reference URI="#${id}">`;
          }

          res += `<${currentPrefix}Transforms>`;
          for (const trans of ref.transforms || []) {
            const transform = getTransformByAlgorithm(trans);
            res += `<${currentPrefix}Transform Algorithm="${transform.getAlgorithmName()}"`;
            if (isArrayHasLength(ref.inclusiveNamespacesPrefixList)) {
              res += ">";
              res += `<InclusiveNamespaces PrefixList="${ref.inclusiveNamespacesPrefixList.join(" ")}" xmlns="${transform.getAlgorithmName()}"/>`;
              res += `</${currentPrefix}Transform>`;
            } else {
              res += " />";
            }
          }

          const canonXml = self.getCanonReferenceXml(doc, ref, node);
          const digestAlgorithm = findHashAlgorithm(ref.digestAlgorithm);
          res +=
            `</${currentPrefix}Transforms>` +
            `<${currentPrefix}DigestMethod Algorithm="${digestAlgorithm.getAlgorithmName()}" />` +
            `<${currentPrefix}DigestValue>${digestAlgorithm.getHash(canonXml)}</${currentPrefix}DigestValue>` +
            `</${currentPrefix}Reference>`;
        }
      }

      return res;
    },

    createSignedInfo(doc: Document, prefix?: string): string {
      if (typeof self.canonicalizationAlgorithm !== "string") {
        throw new Error(
          "Missing canonicalizationAlgorithm when trying to create signed info for XML",
        );
      }

      const transform = getTransformByAlgorithm(self.canonicalizationAlgorithm);
      const algo = findSignatureAlgorithm(self.signatureAlgorithm);
      const currentPrefix = prefix ? `${prefix}:` : "";

      let res = `<${currentPrefix}SignedInfo>`;
      res += `<${currentPrefix}CanonicalizationMethod Algorithm="${transform.getAlgorithmName()}"`;
      if (isArrayHasLength(self.inclusiveNamespacesPrefixList)) {
        res += ">";
        res += `<InclusiveNamespaces PrefixList="${self.inclusiveNamespacesPrefixList.join(" ")}" xmlns="${transform.getAlgorithmName()}"/>`;
        res += `</${currentPrefix}CanonicalizationMethod>`;
      } else {
        res += " />";
      }
      res += `<${currentPrefix}SignatureMethod Algorithm="${algo.getAlgorithmName()}" />`;
      res += self.createReferences(doc, prefix);
      res += `</${currentPrefix}SignedInfo>`;
      return res;
    },

    createSignature(prefix?: string): Node {
      let xmlNsAttr = "xmlns";
      let currentPrefix = "";
      if (prefix) {
        xmlNsAttr += `:${prefix}`;
        currentPrefix = `${prefix}:`;
      }

      const signatureValueXml = `<${currentPrefix}SignatureValue>${self.signatureValue}</${currentPrefix}SignatureValue>`;
      const wrapper = `<${currentPrefix}Signature ${xmlNsAttr}="http://www.w3.org/2000/09/xmldsig#">${signatureValueXml}</${currentPrefix}Signature>`;
      const doc = safeParseXml(wrapper, "text/xml");
      return doc.documentElement.firstChild as Node;
    },

    async calculateSignatureValue(doc: Document): Promise<void> {
      const signedInfoCanon = self.getCanonSignedInfoXml(doc);
      const signer = findSignatureAlgorithm(self.signatureAlgorithm);
      if (self.privateKey == null) {
        throw new Error("Private key is required to compute signature");
      }
      self.signatureValue = await signer.getSignature(signedInfoCanon, self.privateKey);
    },

    getKeyInfo(prefix?: string): string {
      const currentPrefix = prefix ? `${prefix}:` : "";
      let keyInfoAttrs = "";
      if (self.keyInfoAttributes) {
        Object.keys(self.keyInfoAttributes).forEach((name) => {
          keyInfoAttrs += ` ${name}="${self.keyInfoAttributes[name]}"`;
        });
      }
      const keyInfoContent = self.getKeyInfoContent({
        publicCert: self.publicCert,
        prefix,
      });
      if (keyInfoAttrs || keyInfoContent) {
        return `<${currentPrefix}KeyInfo${keyInfoAttrs}>${keyInfoContent || ""}</${currentPrefix}KeyInfo>`;
      }
      return "";
    },

    async computeSignature(xml: string, options?: ComputeSignatureOptions): Promise<void> {
      options = options || {};
      const doc = safeParseXml(xml, "text/xml");

      let xmlNsAttr = "xmlns";
      const signatureAttrs: string[] = [];
      const validActions = ["append", "prepend", "before", "after"];
      const prefix = options.prefix;
      const attrs = options.attrs || {};
      const location = options.location || {};
      const existingPrefixes = options.existingPrefixes || {};

      location.reference = location.reference || "/*";
      location.action = location.action || "append";

      if (validActions.indexOf(location.action) === -1) {
        throw new Error(
          `location.action option has an invalid action: ${location.action}, must be any of the following values: ${validActions.join(", ")}`,
        );
      }

      let currentPrefix = "";
      if (prefix) {
        xmlNsAttr += `:${prefix}`;
        currentPrefix = `${prefix}:`;
      }

      Object.keys(attrs).forEach((name) => {
        if (name !== "xmlns" && name !== xmlNsAttr) {
          signatureAttrs.push(`${name}="${attrs[name]}"`);
        }
      });

      signatureAttrs.push(`${xmlNsAttr}="http://www.w3.org/2000/09/xmldsig#"`);

      let signatureXml = `<${currentPrefix}Signature ${signatureAttrs.join(" ")}>`;
      signatureXml += self.createSignedInfo(doc, prefix);
      signatureXml += self.getKeyInfo(prefix);
      signatureXml += `</${currentPrefix}Signature>`;

      self.originalXmlWithIds = serializeXmlNode(doc);

      let existingPrefixesString = "";
      Object.keys(existingPrefixes).forEach((key) => {
        existingPrefixesString += `xmlns:${key}="${existingPrefixes[key]}" `;
      });

      const dummySignatureWrapper = `<Dummy ${existingPrefixesString}>${signatureXml}</Dummy>`;
      const nodeXml = safeParseXml(dummySignatureWrapper, "text/xml");
      const signatureDoc = nodeXml.documentElement.firstChild as Node;

      const referenceNode = selectNodes(location.reference, doc)[0];
      if (!isElementNode(referenceNode)) {
        throw new Error(
          `the following xpath cannot be used because it was not found: ${location.reference}`,
        );
      }

      if (location.action === "append") {
        referenceNode.appendChild(signatureDoc);
      } else if (location.action === "prepend") {
        referenceNode.insertBefore(signatureDoc, referenceNode.firstChild);
      } else if (location.action === "before") {
        if (!referenceNode.parentNode) {
          throw new Error(
            "`location.reference` refers to the root node (by default), so we cannot insert `before`",
          );
        }
        referenceNode.parentNode.insertBefore(signatureDoc, referenceNode);
      } else if (location.action === "after") {
        if (!referenceNode.parentNode) {
          throw new Error(
            "`location.reference` refers to the root node (by default), so we cannot insert `after`",
          );
        }
        referenceNode.parentNode.insertBefore(signatureDoc, referenceNode.nextSibling);
      }

      self.signatureNode = signatureDoc;

      const signedInfoNodes = findChildren(self.signatureNode, "SignedInfo");
      if (signedInfoNodes.length === 0) {
        throw new Error("could not find SignedInfo element in the message");
      }

      await self.calculateSignatureValue(doc);
      signatureDoc.insertBefore(self.createSignature(prefix), signedInfoNodes[0].nextSibling);
      self.signatureXml = (signatureDoc as { toString(): string }).toString();
      self.signedXml = serializeXmlNode(doc);
    },

    loadReference(refNode: Node) {
      const nodeStr = (n: Node) => (n as { toString(): string }).toString();
      let nodes = findChildren(refNode, "DigestMethod");
      if (nodes.length === 0) {
        throw new Error(`could not find DigestMethod in reference ${nodeStr(refNode)}`);
      }
      const digestAlgoNode = nodes[0];
      const digestAttr = findAttr(digestAlgoNode, "Algorithm");
      if (!digestAttr) {
        throw new Error(`could not find Algorithm attribute in node ${nodeStr(digestAlgoNode)}`);
      }
      const digestAlgo = digestAttr.value;

      nodes = findChildren(refNode, "DigestValue");
      if (nodes.length === 0) {
        throw new Error(`could not find DigestValue node in reference ${nodeStr(refNode)}`);
      }
      if (nodes.length > 1) {
        throw new Error(
          `could not load reference for a node that contains multiple DigestValue nodes: ${nodeStr(refNode)}`,
        );
      }

      const digestValue = nodes[0].textContent || "";
      if (!digestValue) {
        throw new Error(`could not find the value of DigestValue in ${nodeStr(refNode)}`);
      }

      const transforms: string[] = [];
      let inclusiveNamespacesPrefixList: string[] = [];

      nodes = findChildren(refNode, "Transforms");
      if (nodes.length !== 0) {
        const transformsNode = nodes[0];
        const transformsAll = findChildren(transformsNode, "Transform");
        for (const transform of transformsAll) {
          const transformAttr = findAttr(transform, "Algorithm");
          if (transformAttr) {
            transforms.push(transformAttr.value);
          }
        }

        const lastTransform = transformsAll[transformsAll.length - 1];
        if (lastTransform) {
          const inclusiveNamespaces = findChildren(lastTransform, "InclusiveNamespaces");
          if (isArrayHasLength(inclusiveNamespaces)) {
            const values: string[] = [];
            inclusiveNamespaces.forEach((namespaceNode) => {
              const prefixList = namespaceNode.getAttribute("PrefixList") || "";
              prefixList.split(" ").forEach((v) => {
                if (v.length > 0) {
                  values.push(v);
                }
              });
            });
            inclusiveNamespacesPrefixList = values;
          }
        }
      }

      if (
        transforms.length === 0 ||
        transforms[transforms.length - 1] ===
          "http://www.w3.org/2000/09/xmldsig#enveloped-signature"
      ) {
        transforms.push("http://www.w3.org/2001/10/xml-exc-c14n#");
      }

      const refUri = isElementNode(refNode) ? refNode.getAttribute("URI") : null;
      self.addReference({
        transforms,
        digestAlgorithm: digestAlgo,
        uri: refUri === null ? undefined : refUri,
        digestValue,
        inclusiveNamespacesPrefixList,
        isEmptyUri: refUri === "",
      });
    },

    loadSignature(signatureNode: string | Node) {
      if (typeof signatureNode === "string") {
        self.signatureNode = safeParseXml(signatureNode, "text/xml");
      } else {
        self.signatureNode = signatureNode;
      }

      self.signatureXml = (self.signatureNode! as { toString(): string }).toString();

      const canonicalizationAlgorithmNode = selectNodes(
        ".//*[local-name(.)='CanonicalizationMethod']/@Algorithm",
        self.signatureNode,
      )[0];
      if (!canonicalizationAlgorithmNode) {
        throw new Error("could not find CanonicalizationMethod/@Algorithm element");
      }
      if (isAttributeNode(canonicalizationAlgorithmNode)) {
        self.canonicalizationAlgorithm = canonicalizationAlgorithmNode.value;
      }

      const signatureAlgorithmNode = selectNodes(
        ".//*[local-name(.)='SignatureMethod']/@Algorithm",
        self.signatureNode,
      )[0];
      if (isAttributeNode(signatureAlgorithmNode)) {
        self.signatureAlgorithm = signatureAlgorithmNode.value;
      }

      const signedInfoNodes = findChildren(self.signatureNode, "SignedInfo");
      if (!isArrayHasLength(signedInfoNodes)) {
        throw new Error("no signed info node found");
      }
      if (signedInfoNodes.length > 1) {
        throw new Error("could not load signature that contains multiple SignedInfo nodes");
      }

      self.references = [];
      self.signedReferences = [];

      const signatureValueNode = selectNodes(
        ".//*[local-name(.)='SignatureValue']/text()",
        self.signatureNode,
      )[0];
      if (isTextNode(signatureValueNode)) {
        self.signatureValue = signatureValueNode.data.replace(/\r?\n/g, "");
      }

      const keyInfoNode = selectNodes(".//*[local-name(.)='KeyInfo']", self.signatureNode)[0];
      if (isElementNode(keyInfoNode)) {
        self.keyInfo = keyInfoNode;
      }
    },

    validateReference(ref: XmlReference, doc: Document): boolean {
      const uri = ref.uri && ref.uri[0] === "#" ? ref.uri.substring(1) : ref.uri;
      let elem: Node | null = null;

      if (uri === "") {
        const firstNode = selectNodes("//*", doc)[0];
        elem = isElementNode(firstNode) ? firstNode : null;
      } else if (uri && uri.indexOf("'") !== -1) {
        throw new Error("Cannot validate a uri with quotes inside it");
      } else if (uri) {
        let numElementsForId = 0;
        for (const attr of self.idAttributes) {
          const tmpElemXpath = `//*[@*[local-name(.)='${attr}']='${uri}']`;
          const tmpElem = selectNodes(tmpElemXpath, doc);
          if (isArrayHasLength(tmpElem)) {
            numElementsForId += tmpElem.length;
            if (numElementsForId > 1) {
              throw new Error(
                "Cannot validate a document which contains multiple elements with the same value for ID attributes",
              );
            }
            const matched = tmpElem[0];
            elem = isElementNode(matched) ? matched : null;
            ref.xpath = tmpElemXpath;
          }
        }
      }

      if (!elem) {
        ref.validationError = new Error(
          `invalid signature: the signature references an element with uri ${ref.uri} but could not find such element in the xml`,
        );
        return false;
      }

      const canonXml = self.getCanonReferenceXml(doc, ref, elem);
      const hash = findHashAlgorithm(ref.digestAlgorithm);
      const digest = hash.getHash(canonXml);

      if (digest !== ref.digestValue) {
        ref.validationError = new Error(
          `invalid signature: for uri ${ref.uri} calculated digest is ${digest} but xml supplies digest ${ref.digestValue}`,
        );
        return false;
      }

      self.signedReferences.push(canonXml);
      ref.signedReference = canonXml;
      return true;
    },

    async checkSignature(xml: string): Promise<boolean> {
      self.signedXml = xml;
      const doc = safeParseXml(xml, "text/xml");

      self.references = [];
      const unverifiedSignedInfoCanon = self.getCanonSignedInfoXml(doc);
      if (!unverifiedSignedInfoCanon) {
        throw new Error("Canonical signed info cannot be empty");
      }

      const parsedUnverifiedSignedInfo = safeParseXml(unverifiedSignedInfoCanon, "text/xml");
      const unverifiedSignedInfoDoc = parsedUnverifiedSignedInfo.documentElement;
      if (!unverifiedSignedInfoDoc) {
        throw new Error("Could not parse unverifiedSignedInfoCanon into a document");
      }

      const references = findChildren(unverifiedSignedInfoDoc, "Reference");
      if (!isArrayHasLength(references)) {
        throw new Error("could not find any Reference elements");
      }

      for (const reference of references) {
        self.loadReference(reference);
      }

      if (!self.references.every((ref) => self.validateReference(ref, doc))) {
        self.signedReferences = [];
        self.references.forEach((ref) => {
          ref.signedReference = undefined;
        });
        return false;
      }

      const signer = findSignatureAlgorithm(self.signatureAlgorithm);
      const key = self.publicCert || self.getCertFromKeyInfo(self.keyInfo) || self.privateKey;
      if (key == null) {
        throw new Error("KeyInfo or publicCert or privateKey is required to validate signature");
      }

      const result = await signer.verifySignature(
        unverifiedSignedInfoCanon,
        key,
        self.signatureValue,
      );
      if (!result) {
        self.signedReferences = [];
        self.references.forEach((ref) => {
          ref.signedReference = undefined;
        });
      }
      return result;
    },

    getSignedXml(): string {
      return self.signedXml;
    },

    getSignatureXml(): string {
      return self.signatureXml;
    },

    getOriginalXmlWithIds(): string {
      return self.originalXmlWithIds;
    },

    setPrivateKey(privateKey: BinaryLike) {
      self.privateKey = toUtf8String(privateKey);
    },

    setPublicCert(publicCert: string) {
      self.publicCert = publicCert;
    },
  };

  return self;
}

function getSigningScheme(
  sigAlg: string | undefined,
  nrsaAliasMapping: { [key: string]: string },
  defaultSignatureAlgorithm: string,
): string {
  if (sigAlg) {
    const algAlias = nrsaAliasMapping[sigAlg];
    if (!(algAlias === undefined)) {
      return algAlias;
    }
  }
  return nrsaAliasMapping[defaultSignatureAlgorithm];
}

/** Sign the octet string of a redirect-binding SAML message (detached signature). */
export async function constructMessageSignature(
  opts: ConstructMessageSignatureOptions,
): Promise<string> {
  const {
    octetString,
    key,
    passphrase,
    isBase64,
    signingAlgorithm,
    nrsaAliasMapping,
    defaultSignatureAlgorithm,
    readPrivateKey,
    signMessage,
  } = opts;

  const signature = await signMessage({
    octetString,
    privateKey: readPrivateKey(key, passphrase),
    signingScheme: getSigningScheme(signingAlgorithm, nrsaAliasMapping, defaultSignatureAlgorithm),
    isBase64Output: isBase64 !== false,
  });
  return isBase64 !== false ? String(signature) : (signature as string);
}

/** Verify the detached signature of a redirect-binding SAML message. */
export async function verifyMessageSignature(
  opts: VerifyMessageSignatureOptions,
): Promise<boolean> {
  const {
    octetString,
    signature,
    signCert,
    verifyAlgorithm,
    nrsaAliasMapping,
    defaultSignatureAlgorithm,
    getPublicKeyPemFromCertificate,
    verifyMessage,
  } = opts;

  const signingScheme = getSigningScheme(
    verifyAlgorithm,
    nrsaAliasMapping,
    defaultSignatureAlgorithm,
  );
  return verifyMessage({
    octetString,
    signature,
    publicKey: getPublicKeyPemFromCertificate(signCert),
    signingScheme,
  });
}

/** Build an enveloped XML-dsig signature over a SAML message or assertion. */
export async function constructSamlSignature(opts: ConstructSamlSignatureOptions): Promise<string> {
  const {
    rawSamlMessage,
    referenceTagXPath,
    privateKey,
    privateKeyPass,
    signatureAlgorithm,
    transformationAlgorithms = [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    signingCert,
    signatureConfig,
    isBase64Output = true,
    isMessageSigned = false,
    getDigestMethod,
    getKeyInfo,
    readPrivateKey,
    base64Encode,
  } = opts;

  const sig = createSignedXml();
  const digestAlgorithm = getDigestMethod(signatureAlgorithm);

  if (!digestAlgorithm) {
    throw new Error("ERR_MISSING_DIGEST_ALGORITHM");
  }

  if (referenceTagXPath) {
    sig.addReference({
      xpath: referenceTagXPath,
      transforms: transformationAlgorithms,
      digestAlgorithm,
    });
  }
  if (isMessageSigned) {
    sig.addReference({
      xpath: "/*",
      transforms: transformationAlgorithms,
      digestAlgorithm,
    });
  }

  const signingCertString = toUtf8String(signingCert);

  sig.signatureAlgorithm = signatureAlgorithm;
  sig.setPublicCert(getKeyInfo(signingCertString, signatureConfig).getKey());
  sig.getKeyInfoContent = getKeyInfo(signingCertString, signatureConfig).getKeyInfo;
  sig.setPrivateKey(readPrivateKey(privateKey, privateKeyPass, true) as BinaryLike);
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";

  if (signatureConfig) {
    await sig.computeSignature(rawSamlMessage, signatureConfig);
  } else {
    await sig.computeSignature(rawSamlMessage);
  }

  return isBase64Output !== false ? base64Encode(sig.getSignedXml()) : sig.getSignedXml();
}
