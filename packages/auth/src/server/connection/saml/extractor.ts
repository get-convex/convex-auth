import { getContext } from "./api";
import camelCase from "camelcase";

/** A list of field descriptors driving {@link extract}. */
export type ExtractorFields = ExtractorField[];

interface ExtractorField {
  key: string;
  localPath: string[] | string[][];
  attributes: string[];
  index?: string[];
  attributePath?: string[];
  context?: boolean;
  shortcut?: string;
}

export const loginRequestFields: ExtractorFields = [
  {
    key: "request",
    localPath: ["AuthnRequest"],
    attributes: ["ID", "IssueInstant", "Destination", "AssertionConsumerServiceURL"],
  },
  {
    key: "issuer",
    localPath: ["AuthnRequest", "Issuer"],
    attributes: [],
  },
  {
    key: "nameIDPolicy",
    localPath: ["AuthnRequest", "NameIDPolicy"],
    attributes: ["Format", "AllowCreate"],
  },
  {
    key: "authnContextClassRef",
    localPath: ["AuthnRequest", "AuthnContextClassRef"],
    attributes: [],
  },
  {
    key: "signature",
    localPath: ["AuthnRequest", "Signature"],
    attributes: [],
    context: true,
  },
];

export const loginResponseStatusFields = [
  {
    key: "top",
    localPath: ["Response", "Status", "StatusCode"],
    attributes: ["Value"],
  },
  {
    key: "second",
    localPath: ["Response", "Status", "StatusCode", "StatusCode"],
    attributes: ["Value"],
  },
];

export const logoutResponseStatusFields = [
  {
    key: "top",
    localPath: ["LogoutResponse", "Status", "StatusCode"],
    attributes: ["Value"],
  },
  {
    key: "second",
    localPath: ["LogoutResponse", "Status", "StatusCode", "StatusCode"],
    attributes: ["Value"],
  },
];

export const loginResponseFields: (assertion: string) => ExtractorFields = (assertion) => [
  {
    key: "conditions",
    localPath: ["Assertion", "Conditions"],
    attributes: ["NotBefore", "NotOnOrAfter"],
    shortcut: assertion,
  },
  {
    key: "response",
    localPath: ["Response"],
    attributes: ["ID", "IssueInstant", "Destination", "InResponseTo"],
  },
  {
    key: "assertionSignature",
    localPath: ["Assertion", "Signature"],
    attributes: [],
    context: true,
    shortcut: assertion,
  },
  {
    key: "audience",
    localPath: ["Assertion", "Conditions", "AudienceRestriction", "Audience"],
    attributes: [],
    shortcut: assertion,
  },
  {
    key: "issuer",
    localPath: ["Assertion", "Issuer"],
    attributes: [],
    shortcut: assertion,
  },
  {
    key: "nameID",
    localPath: ["Assertion", "Subject", "NameID"],
    attributes: [],
    shortcut: assertion,
  },
  {
    key: "subjectConfirmation",
    localPath: ["Assertion", "Subject", "SubjectConfirmation", "SubjectConfirmationData"],
    attributes: ["NotOnOrAfter", "Recipient", "InResponseTo"],
    shortcut: assertion,
  },
  {
    key: "sessionIndex",
    localPath: ["Assertion", "AuthnStatement"],
    attributes: ["AuthnInstant", "SessionNotOnOrAfter", "SessionIndex"],
    shortcut: assertion,
  },
  {
    key: "attributes",
    localPath: ["Assertion", "AttributeStatement", "Attribute"],
    index: ["Name"],
    attributePath: ["AttributeValue"],
    attributes: [],
    shortcut: assertion,
  },
];

export const logoutRequestFields: ExtractorFields = [
  {
    key: "request",
    localPath: ["LogoutRequest"],
    attributes: ["ID", "IssueInstant", "Destination"],
  },
  {
    key: "issuer",
    localPath: ["LogoutRequest", "Issuer"],
    attributes: [],
  },
  {
    key: "nameID",
    localPath: ["LogoutRequest", "NameID"],
    attributes: [],
  },
  {
    key: "sessionIndex",
    localPath: ["LogoutRequest", "SessionIndex"],
    attributes: [],
  },
  {
    key: "signature",
    localPath: ["LogoutRequest", "Signature"],
    attributes: [],
    context: true,
  },
];

export const logoutResponseFields: ExtractorFields = [
  {
    key: "response",
    localPath: ["LogoutResponse"],
    attributes: ["ID", "Destination", "InResponseTo"],
  },
  {
    key: "issuer",
    localPath: ["LogoutResponse", "Issuer"],
    attributes: [],
  },
  {
    key: "signature",
    localPath: ["LogoutResponse", "Signature"],
    attributes: [],
    context: true,
  },
];

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function nodeLocalName(node: Element | Document): string {
  return ("localName" in node && node.localName) || node.nodeName;
}

function matchingChildElements(parent: Node, isWildcard: boolean, match: string): Element[] {
  const next: Element[] = [];
  const childNodes = parent.childNodes;
  if (!childNodes) return next;
  for (let i = 0; i < childNodes.length; i++) {
    const child = childNodes.item(i);
    if (child === null || !isElement(child)) continue;
    const localName = child.localName || child.nodeName;
    if (isWildcard ? localName.includes(match) : localName === match) {
      next.push(child);
    }
  }
  return next;
}

/**
 * Walk a path of local-name segments from a document's root element. A "~name"
 * prefix in a segment means contains-match instead of exact local-name match.
 */
function walkPath(doc: Document, path: string[]): Element[] {
  if (path.length === 0) return [];

  const root: Element | Document = doc.documentElement || doc;
  const [first, ...rest] = path;

  const isWildcard0 = first.startsWith("~");
  const match0 = isWildcard0 ? first.slice(1) : first;
  const rootName = nodeLocalName(root);
  if (isWildcard0 ? !rootName.includes(match0) : rootName !== match0) {
    return [];
  }

  let current: Array<Element | Document> = [root];
  for (const name of rest) {
    const isWildcard = name.startsWith("~");
    const match = isWildcard ? name.slice(1) : name;
    const next: Element[] = [];
    for (const parent of current) {
      next.push(...matchingChildElements(parent, isWildcard, match));
    }
    current = next;
  }
  return current.filter(isElement);
}

function walkChildren(node: Element, path: string[]): Element[] {
  let current: Element[] = [node];
  for (const name of path) {
    const isWildcard = name.startsWith("~");
    const match = isWildcard ? name.slice(1) : name;
    const next: Element[] = [];
    for (const parent of current) {
      next.push(...matchingChildElements(parent, isWildcard, match));
    }
    current = next;
  }
  return current;
}

function isCharacterData(node: Node): node is CharacterData {
  return node.nodeType === 3 || node.nodeType === 4;
}

function getTextContent(node: Node | null): string | null {
  if (!node) return null;
  if (typeof node.textContent === "string") return node.textContent || null;
  let text = "";
  const childNodes = node.childNodes;
  if (childNodes) {
    for (let i = 0; i < childNodes.length; i++) {
      const c = childNodes.item(i);
      if (c === null) continue;
      if (isCharacterData(c)) {
        text += c.data || c.nodeValue || "";
      }
    }
  }
  return text || null;
}

function isNestedPath(localPath: string[] | string[][]): localPath is string[][] {
  return Array.isArray(localPath[0]);
}

/** Session info from a SAML response's `<AuthnStatement>`; `null` when absent. */
export interface SamlSessionIndex {
  authnInstant?: string;
  sessionNotOnOrAfter?: string;
  sessionIndex?: string;
}

/** Validity window from a SAML response's `<Conditions>`; `null` when absent. */
export interface SamlConditions {
  notBefore?: string;
  notOnOrAfter?: string;
}

/** Fields read from a parsed SAML login response ({@link loginResponseFields}). */
export interface SamlResponseExtract {
  issuer?: string | null;
  sessionIndex: SamlSessionIndex | SamlSessionIndex[] | null;
  conditions?: SamlConditions | null;
}

/** Status codes extracted from a response ({@link loginResponseStatusFields} / {@link logoutResponseStatusFields}). */
export interface SamlStatusExtract {
  top?: string;
  second?: string;
}

/** The single assertion node extracted via a `context: true` selector. */
export interface SamlAssertionExtract {
  assertion?: string | string[] | null;
}

type FlatExtractKind = "entire" | "indexed" | "multiAttr" | "singleAttr" | "text";

function classifyFlatField(field: ExtractorField): FlatExtractKind {
  if (field.context) return "entire";
  if (field.index && field.attributePath) return "indexed";
  if (field.attributes.length > 1) return "multiAttr";
  if (field.attributes.length === 1) return "singleAttr";
  return "text";
}

function extractNested(targetDoc: Document, localPath: string[][]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const path of localPath) {
    const nodes = walkPath(targetDoc, path);
    for (const n of nodes) {
      const v = getTextContent(n);
      if (v !== null && !seen.has(v)) {
        seen.add(v);
        values.push(v);
      }
    }
  }
  return values;
}

function extractEntire(targetNodes: Element[]): string | string[] | null {
  let value: string | string[] | null = null;
  if (targetNodes.length === 1) value = targetNodes[0].toString();
  else if (targetNodes.length > 1) value = targetNodes.map((n) => n.toString());
  return value;
}

function extractIndexed(
  targetNodes: Element[],
  attributes: string[],
  index: string[],
  attributePath: string[],
): Record<string, unknown> {
  const indexAttr = index[0];
  const obj: Record<string, unknown> = {};
  for (const parentNode of targetNodes) {
    const idxVal = parentNode.getAttribute ? parentNode.getAttribute(indexAttr) : null;
    if (!idxVal) continue;
    const childNodes = walkChildren(parentNode, attributePath);
    const childValues: Array<string | null | Record<string, string>> = childNodes.map((c) => {
      if (attributes.length === 0) return getTextContent(c);
      if (attributes.length === 1) return c.getAttribute ? c.getAttribute(attributes[0]) : null;
      const o: Record<string, string> = {};
      for (const attr of attributes) {
        const v = c.getAttribute ? c.getAttribute(attr) : null;
        if (v !== null) o[camelCase(attr, { locale: "en-us" })] = v;
      }
      return o;
    });
    obj[idxVal] = childValues.length === 1 ? childValues[0] : childValues;
  }
  return obj;
}

function extractMultiAttr(
  targetNodes: Element[],
  attributes: string[],
): Record<string, string> | Record<string, string>[] | null {
  const values = targetNodes.map((n) => {
    const o: Record<string, string> = {};
    for (const attr of attributes) {
      const v = n.getAttribute ? n.getAttribute(attr) : null;
      if (v !== null) o[camelCase(attr, { locale: "en-us" })] = v;
    }
    return o;
  });
  return values.length === 0 ? null : values.length === 1 ? values[0] : values;
}

function extractSingleAttr(targetNodes: Element[], attributes: string[]): string | undefined {
  const attr = attributes[0];
  const vals = targetNodes
    .map((n) => (n.getAttribute ? n.getAttribute(attr) : null))
    .filter((v): v is string => v !== null);
  return vals.length > 0 ? vals[0] : undefined;
}

function extractText(targetNodes: Element[]): string | string[] | null {
  if (targetNodes.length === 0) return null;
  if (targetNodes.length === 1) return getTextContent(targetNodes[0]);
  const texts = targetNodes
    .map((n) => {
      if (n.firstChild) return n.firstChild.nodeValue ?? null;
      return null;
    })
    .filter((t): t is string => t !== null);
  return texts.length > 0 ? texts : null;
}

/**
 * Parse `context` XML and pull each field's value per its descriptor. The
 * descriptors drive a genuinely-open result; the optional type parameter narrows
 * it to one of the message-kind shapes above, and is the single boundary where
 * the open record is asserted to that typed shape.
 */
export function extract<T = Record<string, unknown>>(context: string, fields: ExtractorField[]): T {
  const { dom } = getContext();
  const rootDoc = dom!.parseFromString(context);
  const shortcutDocs = new Map<string, Document>();
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const { key, localPath, attributes, index, attributePath } = field;
    const shortcut = field.shortcut;

    let targetDoc = rootDoc;
    if (shortcut) {
      let cached = shortcutDocs.get(shortcut);
      if (cached === undefined) {
        cached = dom!.parseFromString(shortcut);
        shortcutDocs.set(shortcut, cached);
      }
      targetDoc = cached;
    }

    if (isNestedPath(localPath)) {
      result[key] = extractNested(targetDoc, localPath);
      continue;
    }

    const targetNodes = walkPath(targetDoc, localPath);
    const kind = classifyFlatField(field);

    if (kind === "entire") {
      result[key] = extractEntire(targetNodes);
    } else if (kind === "indexed") {
      result[key] = extractIndexed(targetNodes, attributes, index!, attributePath!);
    } else if (kind === "multiAttr") {
      result[key] = extractMultiAttr(targetNodes, attributes);
    } else if (kind === "singleAttr") {
      result[key] = extractSingleAttr(targetNodes, attributes);
    } else {
      result[key] = extractText(targetNodes);
    }
  }

  const value: unknown = result;
  return value as T;
}

/**
 * Narrow a parsed response's open extract to {@link SamlResponseExtract} for the
 * response-validation reads. The extractor yields an open dictionary, so this is
 * the single boundary where it is refined to the response shape.
 */
export function asResponseExtract(extracted: Record<string, unknown>): SamlResponseExtract {
  const value: unknown = extracted;
  return value as SamlResponseExtract;
}
