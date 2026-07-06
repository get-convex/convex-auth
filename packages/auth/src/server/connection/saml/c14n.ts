/** Minimal DOM node shape the canonicalizer operates on. */
export interface CanonicalNode {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  namespaceURI?: string | null;
  prefix?: string | null;
  tagName?: string;
  data?: string;
  nodeValue?: string | null;
  ownerDocument?: unknown;
  parentNode?: CanonicalNode | null;
  childNodes?: ArrayLike<CanonicalNode>;
  nextSibling?: CanonicalNode | null;
  previousSibling?: CanonicalNode | null;
  attributes?: CanonicalNamedNodeMap;
  documentElement?: CanonicalNode;
  removeChild?: (child: CanonicalNode) => CanonicalNode;
  getAttribute?: (name: string) => string | null;
  setAttributeNS?: (namespace: string, qualifiedName: string, value: string) => void;
}

/** Minimal DOM attribute shape used during canonicalization. */
export interface CanonicalAttr {
  name: string;
  value: string;
  localName: string;
  prefix?: string | null;
  namespaceURI?: string | null;
  nodeName: string;
  nodeValue?: string | null;
}

/** Indexed collection of {@link CanonicalAttr} attributes. */
export interface CanonicalNamedNodeMap {
  length: number;
  [index: number]: CanonicalAttr;
  getNamedItem?: (name: string) => CanonicalAttr | null;
}

/** A namespace prefix bound to its URI. */
export interface NamespaceEntry {
  prefix: string;
  namespaceURI: string;
}

/** Options controlling exclusive canonicalization (namespace scope, signature node). */
export interface CanonicalizationOptions {
  inclusiveNamespacesPrefixList?: string[];
  defaultNs?: string;
  defaultNsForPrefix?: { [key: string]: string };
  ancestorNamespaces?: NamespaceEntry[];
  signatureNode?: CanonicalNode;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;

const xmlSpecialToEncodedAttribute: { [key: string]: string } = {
  "&": "&amp;",
  "<": "&lt;",
  '"': "&quot;",
  "\r": "&#xD;",
  "\n": "&#xA;",
  "\t": "&#x9;",
};

const xmlSpecialToEncodedText: { [key: string]: string } = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\r": "&#xD;",
};

function encodeSpecialCharactersInAttribute(attributeValue: string): string {
  return attributeValue.replace(
    /([&<"\r\n\t])/g,
    (_str, item) => xmlSpecialToEncodedAttribute[item],
  );
}

function encodeSpecialCharactersInText(text: string): string {
  return text.replace(/([&<>\r])/g, (_str, item) => xmlSpecialToEncodedText[item]);
}

function isElementNode(node: CanonicalNode): boolean {
  return node.nodeType === ELEMENT_NODE;
}

function isCommentNode(node: CanonicalNode): boolean {
  return node.nodeType === COMMENT_NODE;
}

function isTextNode(node: CanonicalNode): boolean {
  return node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE;
}

function prefixScopeKey(prefix: string, namespaceURI: string): string {
  return prefix + "\x00" + namespaceURI;
}

function isPrefixInScope(scope: Set<string>, prefix: string, namespaceURI: string): boolean {
  return scope.has(prefixScopeKey(prefix, namespaceURI));
}

function attrCompare(a: CanonicalAttr, b: CanonicalAttr): number {
  if (!a.namespaceURI && b.namespaceURI) {
    return -1;
  }
  if (!b.namespaceURI && a.namespaceURI) {
    return 1;
  }
  const left = (a.namespaceURI || "") + a.localName;
  const right = (b.namespaceURI || "") + b.localName;
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function nsCompare(a: NamespaceEntry, b: NamespaceEntry): number {
  return a.prefix.localeCompare(b.prefix);
}

function findChildren(node: CanonicalNode, localName: string): CanonicalNode[] {
  const element = node.documentElement || node;
  const res: CanonicalNode[] = [];
  if (!element.childNodes) {
    return res;
  }
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (isElementNode(child) && child.localName === localName) {
      res.push(child);
    }
  }
  return res;
}

function findDirectChildSignature(node: CanonicalNode): CanonicalNode | null {
  if (!node.childNodes) {
    return null;
  }
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (
      isElementNode(child) &&
      child.localName === "Signature" &&
      child.namespaceURI === "http://www.w3.org/2000/09/xmldsig#"
    ) {
      return child;
    }
  }
  return null;
}

function findAllSignatures(node: CanonicalNode, matches: CanonicalNode[] = []): CanonicalNode[] {
  if (
    isElementNode(node) &&
    node.localName === "Signature" &&
    node.namespaceURI === "http://www.w3.org/2000/09/xmldsig#"
  ) {
    matches.push(node);
  }

  if (node.childNodes) {
    for (let i = 0; i < node.childNodes.length; i++) {
      findAllSignatures(node.childNodes[i], matches);
    }
  }

  return matches;
}

function getSignatureValueText(signatureNode: CanonicalNode): string | null {
  if (!signatureNode.childNodes) {
    return null;
  }
  for (let i = 0; i < signatureNode.childNodes.length; i++) {
    const child = signatureNode.childNodes[i];
    if (isElementNode(child) && child.localName === "SignatureValue" && child.childNodes) {
      for (let j = 0; j < child.childNodes.length; j++) {
        const textNode = child.childNodes[j];
        if (isTextNode(textNode) && typeof textNode.data === "string") {
          return textNode.data;
        }
      }
    }
  }
  return null;
}

function exclusiveRenderAttrs(node: CanonicalNode): string {
  if (isCommentNode(node)) {
    return "";
  }

  const attrListToRender: CanonicalAttr[] = [];
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes[i];
      if (attr.name.indexOf("xmlns") === 0) {
        continue;
      }
      attrListToRender.push(attr);
    }
  }

  attrListToRender.sort(attrCompare);
  const res: string[] = [];
  for (const attr of attrListToRender) {
    res.push(" ", attr.name, '="', encodeSpecialCharactersInAttribute(attr.value), '"');
  }
  return res.join("");
}

function exclusiveRenderNs(
  node: CanonicalNode,
  scope: Set<string>,
  defaultNs: string,
  defaultNsForPrefix: { [key: string]: string },
  inclusiveNamespacesPrefixList: string[],
): { rendered: string; newDefaultNs: string } {
  const res: string[] = [];
  let newDefaultNs = defaultNs;
  const nsListToRender: NamespaceEntry[] = [];
  const currNs = node.namespaceURI || "";

  if (node.prefix) {
    const nodeNs = node.namespaceURI || defaultNsForPrefix[node.prefix] || "";
    if (!isPrefixInScope(scope, node.prefix, nodeNs)) {
      nsListToRender.push({ prefix: node.prefix, namespaceURI: nodeNs });
      scope.add(prefixScopeKey(node.prefix, nodeNs));
    }
  } else if (defaultNs !== currNs) {
    newDefaultNs = node.namespaceURI || "";
    res.push(' xmlns="', newDefaultNs, '"');
  }

  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes[i];

      if (
        attr.prefix &&
        !isPrefixInScope(scope, attr.localName, attr.value) &&
        inclusiveNamespacesPrefixList.indexOf(attr.localName) >= 0
      ) {
        nsListToRender.push({
          prefix: attr.localName,
          namespaceURI: attr.value,
        });
        scope.add(prefixScopeKey(attr.localName, attr.value));
      }

      if (
        attr.prefix &&
        !isPrefixInScope(scope, attr.prefix, attr.namespaceURI || "") &&
        attr.prefix !== "xmlns" &&
        attr.prefix !== "xml"
      ) {
        nsListToRender.push({
          prefix: attr.prefix,
          namespaceURI: attr.namespaceURI || "",
        });
        scope.add(prefixScopeKey(attr.prefix, attr.namespaceURI || ""));
      }
    }
  }

  nsListToRender.sort(nsCompare);
  for (const p of nsListToRender) {
    res.push(" xmlns:", p.prefix, '="', p.namespaceURI, '"');
  }

  return { rendered: res.join(""), newDefaultNs };
}

function exclusiveProcessInner(
  node: CanonicalNode,
  scope: Set<string>,
  defaultNs: string,
  defaultNsForPrefix: { [key: string]: string },
  inclusiveNamespacesPrefixList: string[],
): string {
  if (isCommentNode(node)) {
    return "";
  }

  if (isTextNode(node)) {
    return encodeSpecialCharactersInText(node.data || "");
  }

  if (node.nodeType === PROCESSING_INSTRUCTION_NODE) {
    return "";
  }

  if (isElementNode(node)) {
    const ns = exclusiveRenderNs(
      node,
      scope,
      defaultNs,
      defaultNsForPrefix,
      inclusiveNamespacesPrefixList,
    );
    const nodeTag = node.tagName || node.nodeName;
    const res = ["<", nodeTag, ns.rendered, exclusiveRenderAttrs(node), ">"];
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const pfxCopy = new Set(scope);
        res.push(
          exclusiveProcessInner(
            node.childNodes[i],
            pfxCopy,
            ns.newDefaultNs,
            defaultNsForPrefix,
            inclusiveNamespacesPrefixList,
          ),
        );
      }
    }
    res.push("</", nodeTag, ">");
    return res.join("");
  }

  throw new Error(`Unable to exclusive canonicalize node type: ${node.nodeType}`);
}

function exclusiveProcess(elem: CanonicalNode, options: CanonicalizationOptions = {}): string {
  let inclusiveNamespacesPrefixList = options.inclusiveNamespacesPrefixList || [];
  const defaultNs = options.defaultNs || "";
  const defaultNsForPrefix = options.defaultNsForPrefix || {};
  const ancestorNamespaces = options.ancestorNamespaces || [];

  if (inclusiveNamespacesPrefixList.length === 0) {
    const canonicalizationMethod = findChildren(elem, "CanonicalizationMethod");
    if (canonicalizationMethod.length !== 0) {
      const inclusiveNamespaces = findChildren(canonicalizationMethod[0], "InclusiveNamespaces");
      if (inclusiveNamespaces.length !== 0 && inclusiveNamespaces[0].getAttribute) {
        const prefixList = inclusiveNamespaces[0].getAttribute("PrefixList") || "";
        inclusiveNamespacesPrefixList = prefixList.split(" ").filter(Boolean);
      }
    }
  }

  if (inclusiveNamespacesPrefixList.length > 0) {
    inclusiveNamespacesPrefixList.forEach((prefix) => {
      ancestorNamespaces.forEach((ancestorNamespace) => {
        if (prefix === ancestorNamespace.prefix && elem.setAttributeNS) {
          elem.setAttributeNS(
            "http://www.w3.org/2000/xmlns/",
            `xmlns:${prefix}`,
            ancestorNamespace.namespaceURI,
          );
        }
      });
    });
  }

  return exclusiveProcessInner(
    elem,
    new Set(),
    defaultNs,
    defaultNsForPrefix,
    inclusiveNamespacesPrefixList,
  );
}

function envelopedSignatureProcess(
  node: CanonicalNode,
  options: CanonicalizationOptions = {},
): CanonicalNode {
  if (options.signatureNode == null) {
    const signature = findDirectChildSignature(node);
    if (signature && signature.parentNode && signature.parentNode.removeChild) {
      signature.parentNode.removeChild(signature);
    }
    return node;
  }

  const expectedSignatureValue = getSignatureValueText(options.signatureNode);
  if (expectedSignatureValue) {
    const signatures = findAllSignatures(node);
    for (const nodeSignature of signatures) {
      const signatureValue = getSignatureValueText(nodeSignature);
      if (signatureValue && signatureValue === expectedSignatureValue) {
        if (nodeSignature.parentNode && nodeSignature.parentNode.removeChild) {
          nodeSignature.parentNode.removeChild(nodeSignature);
        }
      }
    }
  }

  return node;
}

/** A canonicalization or enveloped-signature transform usable in a signature reference. */
export interface TransformAlgorithm {
  process(node: CanonicalNode, options?: CanonicalizationOptions): string | CanonicalNode;
  getAlgorithmName(): string;
}

const exclusiveCanonicalization: TransformAlgorithm = {
  process: exclusiveProcess,
  getAlgorithmName: () => "http://www.w3.org/2001/10/xml-exc-c14n#",
};

const envelopedSignature: TransformAlgorithm = {
  process: envelopedSignatureProcess,
  getAlgorithmName: () => "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
};

/** XML-dsig transform algorithm URI → its implementation. */
const TRANSFORM_ALGORITHMS: Record<string, TransformAlgorithm> = {
  "http://www.w3.org/2001/10/xml-exc-c14n#": exclusiveCanonicalization,
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature": envelopedSignature,
};

/** Resolve an XML-dsig transform algorithm URI to its implementation. */
export function getTransformByAlgorithm(algorithm: string): TransformAlgorithm {
  const transform = TRANSFORM_ALGORITHMS[algorithm];
  if (transform === undefined) {
    throw new Error(`canonicalization algorithm '${algorithm}' is not supported`);
  }
  return transform;
}
