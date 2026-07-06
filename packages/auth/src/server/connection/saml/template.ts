import { isString } from "./encoding";
import { type SamlMessageKind } from "./constants";
import camelCase from "camelcase";
import xmlEscape from "xml-escape";

/** Configuration for one `<saml:Attribute>` emitted in a login response. */
export interface LoginResponseAttribute {
  name: string;
  nameFormat: string;
  valueXsiType: string;
  valueTag: string;
  valueXmlnsXs?: string;
  valueXmlnsXsi?: string;
}

/** Optional attribute/attribute-statement templates overriding the defaults. */
export interface LoginResponseAdditionalTemplates {
  attributeStatementTemplate?: AttributeStatementTemplate;
  attributeTemplate?: AttributeTemplate;
}

/** A raw XML template carrying `{tag}` placeholders. */
export interface BaseSamlTemplate {
  context: string;
}

/** Login-response template plus the attributes and sub-templates to expand into it. */
export interface LoginResponseTemplate extends BaseSamlTemplate {
  attributes?: LoginResponseAttribute[];
  additionalTemplates?: LoginResponseAdditionalTemplates;
}
/** Template for a `<saml:AttributeStatement>`. */
export interface AttributeStatementTemplate extends BaseSamlTemplate {}

/** Template for a single `<saml:Attribute>`. */
export interface AttributeTemplate extends BaseSamlTemplate {}

/** The `string | { name; attr }` argument accepted by {@link createXPath}. */
type XPathLocal = string | { name: string; attr: string };

/** Create an XPath that selects an element, its text, or one of its attributes by local name. */
export function createXPath(local: XPathLocal, isExtractAll?: boolean): string {
  if (isString(local)) {
    return isExtractAll === true
      ? "//*[local-name(.)='" + local + "']/text()"
      : "//*[local-name(.)='" + local + "']";
  }
  return "//*[local-name(.)='" + local.name + "']/@" + local.attr;
}

/** Map a SAML message type to the redirect-binding query param (`SAMLRequest`/`SAMLResponse`). */
const QUERY_PARAM_BY_KIND: Record<SamlMessageKind, "SAMLRequest" | "SAMLResponse"> = {
  SAMLRequest: "SAMLRequest",
  LogoutRequest: "SAMLRequest",
  SAMLResponse: "SAMLResponse",
  LogoutResponse: "SAMLResponse",
};

/** The redirect/POST query-param name carrying a message of the given kind. */
export function getQueryParamByType(type: string): "SAMLRequest" | "SAMLResponse" {
  const param = QUERY_PARAM_BY_KIND[type as SamlMessageKind];
  if (param === undefined) {
    throw new Error("ERR_UNDEFINED_QUERY_PARAMS");
  }
  return param;
}

/** Default login request template. */
export const defaultLoginRequestTemplate = {
  context:
    '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" AssertionConsumerServiceURL="{AssertionConsumerServiceURL}"><saml:Issuer>{Issuer}</saml:Issuer><samlp:NameIDPolicy Format="{NameIDFormat}" AllowCreate="{AllowCreate}"/></samlp:AuthnRequest>',
};

/** Default AttributeStatement template. */
export const defaultAttributeStatementTemplate = {
  context: "<saml:AttributeStatement>{Attributes}</saml:AttributeStatement>",
};

/** Default Attribute template. */
export const defaultAttributeTemplate = {
  context:
    '<saml:Attribute Name="{Name}" NameFormat="{NameFormat}"><saml:AttributeValue xmlns:xs="{ValueXmlnsXs}" xmlns:xsi="{ValueXmlnsXsi}" xsi:type="{ValueXsiType}">{Value}</saml:AttributeValue></saml:Attribute>',
};

/** Default logout response template. */
export const defaultLogoutResponseTemplate = {
  context:
    '<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{ID}" Version="2.0" IssueInstant="{IssueInstant}" Destination="{Destination}" InResponseTo="{InResponseTo}"><saml:Issuer>{Issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="{StatusCode}"/></samlp:Status></samlp:LogoutResponse>',
};

function tagging(prefix: string, content: string): string {
  const camelContent = camelCase(content, { locale: "en-us" });
  return prefix + camelContent.charAt(0).toUpperCase() + camelContent.slice(1);
}

function stringifyTagValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return value.toString();
  }
  return (value as { toString(): string }).toString();
}

function escapeTag(replacement: unknown): (...args: string[]) => string {
  return (_match: string, quote?: string) => {
    const text = stringifyTagValue(replacement);
    return quote ? `${quote}${xmlEscape(text)}` : text;
  };
}

/** Replace `{tag}` placeholders inside a raw XML string with their tag values. */
export function replaceTagsByValue(rawXML: string, tagValues: Record<string, unknown>): string {
  Object.keys(tagValues).forEach((t) => {
    rawXML = rawXML.replace(new RegExp(`("?)\\{${t}\\}`, "g"), escapeTag(tagValues[t]));
  });
  return rawXML;
}

/** Build a `<saml:AttributeStatement>` from attribute configs and the attribute templates. */
export function attributeStatementBuilder(
  attributes: LoginResponseAttribute[],
  attributeTemplate: AttributeTemplate = defaultAttributeTemplate,
  attributeStatementTemplate: AttributeStatementTemplate = defaultAttributeStatementTemplate,
): string {
  const attr = attributes
    .map(({ name, nameFormat, valueTag, valueXsiType, valueXmlnsXs, valueXmlnsXsi }) => {
      const defaultValueXmlnsXs = "http://www.w3.org/2001/XMLSchema";
      const defaultValueXmlnsXsi = "http://www.w3.org/2001/XMLSchema-instance";
      let attributeLine = attributeTemplate.context;
      attributeLine = attributeLine.replace("{Name}", name);
      attributeLine = attributeLine.replace("{NameFormat}", nameFormat);
      attributeLine = attributeLine.replace(
        "{ValueXmlnsXs}",
        valueXmlnsXs ? valueXmlnsXs : defaultValueXmlnsXs,
      );
      attributeLine = attributeLine.replace(
        "{ValueXmlnsXsi}",
        valueXmlnsXsi ? valueXmlnsXsi : defaultValueXmlnsXsi,
      );
      attributeLine = attributeLine.replace("{ValueXsiType}", valueXsiType);
      attributeLine = attributeLine.replace("{Value}", `{${tagging("attr", valueTag)}}`);
      return attributeLine;
    })
    .join("");
  return attributeStatementTemplate.context.replace("{Attributes}", attr);
}
