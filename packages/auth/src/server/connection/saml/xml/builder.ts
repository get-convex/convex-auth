/** A node in the XML description tree: text, an element/attribute object, or an ordered list. */
export type XmlNode = string | number | boolean | null | undefined | XmlObject | XmlNode[];

/**
 * An object node. A reserved `_attr` member supplies attributes for the
 * enclosing element; every other key is a child tag name.
 */
export interface XmlObject {
  [key: string]: XmlNode;
}

function isXmlObject(value: XmlNode): value is XmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeXmlText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(input: string): string {
  return escapeXmlText(input).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function renderScalar(value: string | number | boolean): string {
  return typeof value === "string" ? value : value.toString();
}

function renderAttributeValue(value: XmlNode): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value) || isXmlObject(value)) return renderValue(value);
  return renderScalar(value);
}

function renderAttributes(attrs: XmlObject): string {
  return Object.keys(attrs)
    .map((key) => {
      const value = attrs[key];
      return ` ${key}="${escapeXmlAttribute(renderAttributeValue(value))}"`;
    })
    .join("");
}

function renderValue(value: XmlNode): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(renderValue).join("");
  }

  if (isXmlObject(value)) {
    return Object.keys(value)
      .map((tagName) => renderElement(tagName, value[tagName]))
      .join("");
  }

  return escapeXmlText(renderScalar(value));
}

function renderElement(tagName: string, value: XmlNode): string {
  let attrs = "";
  let body = "";

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (isXmlObject(item) && item._attr !== undefined && isXmlObject(item._attr)) {
        attrs += renderAttributes(item._attr);
        return;
      }
      body += renderValue(item);
    });
    return `<${tagName}${attrs}>${body}</${tagName}>`;
  }

  if (isXmlObject(value)) {
    if (value._attr !== undefined && isXmlObject(value._attr)) {
      attrs += renderAttributes(value._attr);
      const copied = { ...value };
      delete copied._attr;
      body += renderValue(copied);
    } else {
      body += renderValue(value);
    }
    return `<${tagName}${attrs}>${body}</${tagName}>`;
  }

  body = renderValue(value);
  return `<${tagName}${attrs}>${body}</${tagName}>`;
}

/**
 * Serialize a nested node description into an XML string.
 *
 * Objects become elements keyed by tag name; an `_attr` member supplies
 * attributes; arrays render their items in order. Text is XML-escaped.
 */
export function buildXml(nodes: XmlNode[]): string {
  return nodes.map(renderValue).join("");
}
