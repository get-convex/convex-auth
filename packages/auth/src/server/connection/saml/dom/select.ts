const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const ATTRIBUTE_NODE = 2;

/** A synthetic attribute match produced by an XPath `@attr` terminal step. */
interface SelectedAttr {
  nodeType: typeof ATTRIBUTE_NODE;
  value: string;
  nodeValue: string;
  name: string;
}

/** A node, attribute match, text node, or string value produced by an XPath match. */
export type SelectedValue = Element | Text | SelectedAttr | string;

/** A node an XPath step can descend from. */
type Container = Element | Document;

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function isText(node: Node): node is Text {
  return node.nodeType === TEXT_NODE;
}

function isContainer(value: SelectedValue): value is Element {
  return typeof value !== "string" && value.nodeType === ELEMENT_NODE;
}

export function isElementNode(value: SelectedValue): value is Element {
  return typeof value !== "string" && value.nodeType === 1;
}

export function isTextNode(node: Node): node is Text {
  return node.nodeType === 3;
}

export function serializeXmlNode(node: { toString(): string }): string {
  return node.toString();
}

/** The element a container descends from: a document's root element, or the element itself. */
function rootElement(node: Container): Container | null {
  return "documentElement" in node ? node.documentElement : node;
}

function childElements(parent: Container): Element[] {
  const root = rootElement(parent) ?? parent;
  const result: Element[] = [];
  for (let i = 0; i < root.childNodes.length; i++) {
    const child = root.childNodes.item(i);
    if (child !== null && isElement(child)) result.push(child);
  }
  return result;
}

function descendantElements(container: Container, localName?: string): Element[] {
  const root = rootElement(container) ?? container;
  if (localName !== undefined && "getElementsByTagNameNS" in root) {
    return Array.from(root.getElementsByTagNameNS("*", localName)).filter(isElement);
  }
  const result: Element[] = [];
  const walk = (node: Node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i);
      if (child === null || !isElement(child)) continue;
      if (localName === undefined || child.localName === localName) result.push(child);
      walk(child);
    }
  };
  walk(root);
  return result;
}

function textChildren(parent: Element): Text[] {
  const result: Text[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes.item(i);
    if (child !== null && isText(child)) result.push(child);
  }
  return result;
}

/**
 * Parses the XPath predicate subset used by this library: local-name() exact and
 * contains() matches, attribute equality, named-attribute equality, and " or "/" and ".
 */
function parsePredicate(pred: string): ((el: Element) => boolean) | null {
  pred = pred.trim();

  const exactMatch = pred.match(/^local-name\(\.?\)\s*=\s*'([^']+)'$/);
  if (exactMatch) {
    const name = exactMatch[1];
    return (el) => el.localName === name;
  }

  const containsMatch = pred.match(/^contains\(local-name\(\.?\)\s*,\s*'([^']+)'\)$/);
  if (containsMatch) {
    const part = containsMatch[1];
    return (el) => typeof el.localName === "string" && el.localName.includes(part);
  }

  const attrMatch = pred.match(/^@([^\s=]+)\s*=\s*'([^']*)'$/);
  if (attrMatch) {
    const attr = attrMatch[1];
    const val = attrMatch[2];
    return (el) => el.getAttribute(attr) === val;
  }

  const namedAttrMatch = pred.match(/^@\*\[local-name\(\.?\)\s*=\s*'([^']+)'\]\s*=\s*'([^']*)'$/);
  if (namedAttrMatch) {
    const attrName = namedAttrMatch[1];
    const attrVal = namedAttrMatch[2];
    return (el) => el.getAttribute(attrName) === attrVal;
  }

  const orIdx = pred.indexOf(" or ");
  if (orIdx !== -1) {
    const leftFn = parsePredicate(pred.slice(0, orIdx));
    const rightFn = parsePredicate(pred.slice(orIdx + 4));
    if (leftFn && rightFn) return (el) => leftFn(el) || rightFn(el);
    if (leftFn) return leftFn;
    if (rightFn) return rightFn;
  }

  const andIdx = pred.indexOf(" and ");
  if (andIdx !== -1) {
    const leftFn = parsePredicate(pred.slice(0, andIdx));
    const rightFn = parsePredicate(pred.slice(andIdx + 5));
    if (leftFn && rightFn) return (el) => leftFn(el) && rightFn(el);
    if (leftFn) return leftFn;
    if (rightFn) return rightFn;
  }

  return null;
}

function parseFilter(stepText: string): ((el: Element) => boolean) | null {
  const bracketOpen = stepText.indexOf("[");
  if (bracketOpen === -1) return null;
  const bracketClose = stepText.lastIndexOf("]");
  const pred = stepText.slice(bracketOpen + 1, bracketClose);
  return parsePredicate(pred);
}

interface Step {
  depth: "self" | "child" | "descendant" | "doc-root" | "doc-descendant";
  filter: ((el: Element) => boolean) | null;
  terminal: "element" | "attribute" | "text";
  attrName?: string;
}

function parseXPath(expression: string): Step[] {
  const steps: Step[] = [];

  let expr = expression.trim();

  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "/" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (part === "" && i === 0) {
      if (parts[i + 1] === "" && parts[i + 2] !== undefined) {
        steps.push({
          depth: "doc-descendant",
          filter: parseFilter(parts[i + 2]),
          terminal: "element",
        });
        i += 3;
      } else if (parts[i + 1] !== undefined) {
        steps.push({ depth: "doc-root", filter: parseFilter(parts[i + 1]), terminal: "element" });
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (part === "." && parts[i + 1] === "" && parts[i + 2] !== undefined) {
      steps.push({ depth: "descendant", filter: parseFilter(parts[i + 2]), terminal: "element" });
      i += 3;
      continue;
    }

    if (part === ".") {
      if (parts[i + 1] !== undefined) {
        const nextPart = parts[i + 1];
        if (nextPart.startsWith("@")) {
          steps.push({
            depth: "child",
            filter: null,
            terminal: "attribute",
            attrName: nextPart.slice(1),
          });
          i += 2;
        } else if (nextPart === "text()") {
          steps.push({ depth: "child", filter: null, terminal: "text" });
          i += 2;
        } else {
          steps.push({ depth: "child", filter: parseFilter(nextPart), terminal: "element" });
          i += 2;
        }
      } else {
        i++;
      }
      continue;
    }

    if (part === "") {
      if (parts[i + 1] !== undefined) {
        steps.push({ depth: "descendant", filter: parseFilter(parts[i + 1]), terminal: "element" });
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (part.startsWith("@")) {
      steps.push({ depth: "self", filter: null, terminal: "attribute", attrName: part.slice(1) });
      i++;
      continue;
    }

    if (part === "text()") {
      steps.push({ depth: "self", filter: null, terminal: "text" });
      i++;
      continue;
    }

    steps.push({ depth: "child", filter: parseFilter(part), terminal: "element" });
    i++;
  }

  return steps;
}

function applyStep(step: Step, nodes: SelectedValue[], doc: Container): SelectedValue[] {
  const results: Element[] = [];

  if (step.depth === "doc-root") {
    const root = rootElement(doc);
    if (root !== null && isElement(root) && (!step.filter || step.filter(root))) {
      results.push(root);
    }
  } else if (step.depth === "doc-descendant") {
    for (const el of descendantElements(doc)) {
      if (!step.filter || step.filter(el)) results.push(el);
    }
  } else {
    for (const node of nodes) {
      if (!isContainer(node)) continue;
      if (step.depth === "descendant") {
        for (const el of descendantElements(node)) {
          if (!step.filter || step.filter(el)) results.push(el);
        }
      } else if (step.depth === "child") {
        for (const el of childElements(node)) {
          if (!step.filter || step.filter(el)) results.push(el);
        }
      } else if (step.depth === "self") {
        results.push(node);
      }
    }
  }

  if (results.length === 0) return [];

  if (step.terminal === "attribute") {
    const attrs: SelectedAttr[] = [];
    for (const el of results) {
      if (step.attrName) {
        const val = el.getAttribute(step.attrName);
        if (val !== null) {
          attrs.push({ nodeType: ATTRIBUTE_NODE, value: val, nodeValue: val, name: step.attrName });
        }
      }
    }
    return attrs;
  }

  if (step.terminal === "text") {
    const texts: Text[] = [];
    for (const el of results) {
      texts.push(...textChildren(el));
    }
    return texts;
  }

  return results;
}

function selectedText(value: Exclude<SelectedValue, string>): string {
  if ("textContent" in value && value.textContent !== null) return value.textContent;
  if (value.nodeValue !== null && value.nodeValue !== undefined) return value.nodeValue;
  if ("data" in value && typeof value.data === "string") return value.data;
  return "";
}

/** Evaluate the supported XPath subset against `source`, returning matched nodes/attrs/text. */
export function evaluateXPathToNodes(expression: string, source: Container): SelectedValue[] {
  const expr = expression.trim();

  if (expr.startsWith("string(") && expr.endsWith(")")) {
    const inner = expr.slice(7, -1);
    const nodes = evaluateXPathToNodes(inner, source);
    if (nodes.length === 0) return [];
    const first = nodes[0];
    return [typeof first === "string" ? first : selectedText(first)];
  }

  const steps = parseXPath(expr);
  if (steps.length === 0) return [];

  const doc: Container = source.ownerDocument !== null ? source.ownerDocument : source;
  let current: SelectedValue[] = "documentElement" in source ? [] : [source];
  let isFirst = true;

  for (const step of steps) {
    if (isFirst && (step.depth === "doc-root" || step.depth === "doc-descendant")) {
      current = applyStep(step, [], doc);
    } else {
      current = applyStep(step, current, doc);
    }
    isFirst = false;
  }

  return current;
}

/** Alias of {@link evaluateXPathToNodes}. */
export function selectXPath(expression: string, source: Container): SelectedValue[] {
  return evaluateXPathToNodes(expression, source);
}
