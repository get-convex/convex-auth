/**
 * SAML metadata parsing — pure functions, no classes.
 *
 * Replaces the `Metadata` / `IdpMetadata` / `SpMetadata` class hierarchy with
 * two factory functions and explicit interface contracts, matching the HOF
 * pattern used throughout the rest of the library.
 */

import { extract } from "./extractor";
import type { ExtractorFields } from "./extractor";
import { isString, isNonEmptyArray, castArrayOpt } from "./encoding";
import { BINDING_URI, SamlNamespace, NameIdFormat, ElementsOrder } from "./constants";
import { createKeySection } from "./signature";
import { buildXml } from "./xml/builder";
import type { XmlNode, XmlObject } from "./xml/builder";
import type { MetadataIdpConstructor, MetadataSpConstructor } from "./types";

/** Open dictionary of parsed metadata fields as produced by {@link extract}. */
type ParsedMeta = Record<string, unknown>;

interface SloService {
  binding?: string;
  location?: string;
}

interface AcsService {
  binding?: string;
  location?: string;
}

function isSloService(value: unknown): value is SloService {
  return typeof value === "object" && value !== null;
}

function isAcsService(value: unknown): value is AcsService {
  return typeof value === "object" && value !== null;
}

/**
 * Read a parsed-metadata field as a string. The extractor yields attribute and
 * text values as strings; this preserves the original behavior of returning the
 * raw value (which the accessor contracts type as `string`).
 */
function metaString(meta: ParsedMeta, key: string): string {
  return meta[key] as string;
}

/** Narrow an open metadata value to a record of attributes, or `undefined`. */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accessors common to IdP and SP parsed metadata. */
export interface SamlMetadata {
  readonly xmlString: string;
  getEntityID(): string;
  getX509Certificate(use: string): string | string[] | null;
  getNameIDFormat(): string[];
  getSingleLogoutService(binding: string | undefined): string | object;
}

/** Parsed IdP metadata accessors. */
export interface IdpMetadata extends SamlMetadata {
  isWantAuthnRequestsSigned(): boolean;
  getSingleSignOnService(binding: string): string | object;
}

/** Parsed SP metadata accessors. */
export interface SpMetadata extends SamlMetadata {
  getMetadata(): string;
  isWantAssertionsSigned(): boolean;
  isAuthnRequestSigned(): boolean;
  getAssertionConsumerService(binding: string): string | string[] | undefined;
}

function parseBaseFields(
  xml: string | Uint8Array,
  extraParse: ExtractorFields,
): { xmlString: string; meta: ParsedMeta } {
  const xmlString = xml.toString();
  const parsed: ParsedMeta = extract(xmlString, [
    {
      key: "entityDescriptor",
      localPath: ["EntityDescriptor"],
      attributes: [],
      context: true,
    },
    {
      key: "entityID",
      localPath: ["EntityDescriptor"],
      attributes: ["entityID"],
    },
    {
      key: "sharedCertificate",
      localPath: [
        "EntityDescriptor",
        "~SSODescriptor",
        "KeyDescriptor",
        "KeyInfo",
        "X509Data",
        "X509Certificate",
      ],
      attributes: [],
    },
    {
      key: "certificate",
      localPath: ["EntityDescriptor", "~SSODescriptor", "KeyDescriptor"],
      index: ["use"],
      attributePath: ["KeyInfo", "X509Data", "X509Certificate"],
      attributes: [],
    },
    {
      key: "singleLogoutService",
      localPath: ["EntityDescriptor", "~SSODescriptor", "SingleLogoutService"],
      attributes: ["Binding", "Location"],
    },
    {
      key: "nameIDFormat",
      localPath: ["EntityDescriptor", "~SSODescriptor", "NameIDFormat"],
      attributes: [],
    },
    ...extraParse,
  ]);

  if (typeof parsed.sharedCertificate === "string") {
    parsed.certificate = {
      signing: parsed.sharedCertificate,
      encryption: parsed.sharedCertificate,
    };
    delete parsed.sharedCertificate;
  }

  if (Array.isArray(parsed.entityDescriptor) && parsed.entityDescriptor.length > 1) {
    throw new Error("ERR_MULTIPLE_METADATA_ENTITYDESCRIPTOR");
  }

  return { xmlString, meta: parsed };
}

function getX509Certificate(meta: ParsedMeta, use: string): string | string[] | null {
  const certificate = meta.certificate;
  if (typeof certificate === "object" && certificate !== null) {
    const value = (certificate as Record<string, unknown>)[use];
    return (value as string | string[] | undefined) ?? null;
  }
  return null;
}

function getNameIDFormat(meta: ParsedMeta): string[] {
  return (meta.nameIDFormat as string[] | undefined) ?? [];
}

function getSingleLogoutService(meta: ParsedMeta, binding: string | undefined): string | object {
  if (binding && isString(binding)) {
    const bindType = (BINDING_URI as Record<string, string>)[binding];
    const raw = meta.singleLogoutService;
    const sloServices = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const service = sloServices.find(
      (obj): obj is SloService => isSloService(obj) && obj.binding === bindType,
    );
    if (service) return service.location as string | object;
  }
  return meta.singleLogoutService as string | object;
}

/** Parse IdP metadata, or build it from {@link MetadataIdpOptions} when options are given. */
export function parseIdpMetadata(input: MetadataIdpConstructor): IdpMetadata {
  let xmlInput: string | Uint8Array;

  if (isString(input) || input instanceof Uint8Array) {
    xmlInput = input;
  } else {
    const {
      entityID,
      signingCert,
      encryptCert,
      wantAuthnRequestsSigned = false,
      nameIDFormat = [],
      singleSignOnService = [],
      singleLogoutService = [],
    } = input;

    const IDPSSODescriptor: XmlNode[] = [
      {
        _attr: {
          WantAuthnRequestsSigned: String(wantAuthnRequestsSigned),
          protocolSupportEnumeration: SamlNamespace.protocol,
        },
      },
    ];

    for (const cert of castArrayOpt(signingCert)) {
      IDPSSODescriptor.push({
        KeyDescriptor: createKeySection("signing", cert).KeyDescriptor,
      });
    }
    for (const cert of castArrayOpt(encryptCert)) {
      IDPSSODescriptor.push({
        KeyDescriptor: createKeySection("encryption", cert).KeyDescriptor,
      });
    }
    if (isNonEmptyArray(nameIDFormat)) {
      nameIDFormat.forEach((f: string) => IDPSSODescriptor.push({ NameIDFormat: f }));
    }
    if (isNonEmptyArray(singleSignOnService)) {
      singleSignOnService.forEach((a) => {
        const attr: XmlObject = { Binding: a.Binding, Location: a.Location };
        if (a.isDefault) attr.isDefault = true;
        IDPSSODescriptor.push({ SingleSignOnService: [{ _attr: attr }] });
      });
    } else {
      throw new Error("ERR_IDP_METADATA_MISSING_SINGLE_SIGN_ON_SERVICE");
    }
    if (isNonEmptyArray(singleLogoutService)) {
      singleLogoutService.forEach((a) => {
        const attr: XmlObject = { Binding: a.Binding, Location: a.Location };
        if (a.isDefault) attr.isDefault = true;
        IDPSSODescriptor.push({ SingleLogoutService: [{ _attr: attr }] });
      });
    } else {
      console.warn("Construct identity provider - missing endpoint of SingleLogoutService");
    }

    xmlInput = buildXml([
      {
        EntityDescriptor: [
          {
            _attr: {
              xmlns: SamlNamespace.metadata,
              "xmlns:assertion": SamlNamespace.assertion,
              "xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
              entityID,
            },
          },
          { IDPSSODescriptor },
        ],
      },
    ]);
  }

  const { xmlString, meta } = parseBaseFields(xmlInput, [
    {
      key: "wantAuthnRequestsSigned",
      localPath: ["EntityDescriptor", "IDPSSODescriptor"],
      attributes: ["WantAuthnRequestsSigned"],
    },
    {
      key: "singleSignOnService",
      localPath: ["EntityDescriptor", "IDPSSODescriptor", "SingleSignOnService"],
      index: ["Binding"],
      attributePath: [],
      attributes: ["Location"],
    },
  ]);

  return {
    xmlString,
    getEntityID: () => metaString(meta, "entityID"),
    getX509Certificate: (use) => getX509Certificate(meta, use),
    getNameIDFormat: () => getNameIDFormat(meta),
    getSingleLogoutService: (binding) => getSingleLogoutService(meta, binding),
    isWantAuthnRequestsSigned: () => {
      const v = meta.wantAuthnRequestsSigned;
      return v === "true" || v === true;
    },
    getSingleSignOnService: (binding) => {
      if (isString(binding)) {
        const bindName = (BINDING_URI as Record<string, string>)[binding];
        const map = meta.singleSignOnService;
        if (typeof map === "object" && map !== null) {
          const service = (map as Record<string, unknown>)[bindName];
          if (service) return service as string | object;
        }
      }
      return meta.singleSignOnService as string | object;
    },
  };
}

/** Parse SP metadata, or build it from {@link MetadataSpOptions} when options are given. */
export function parseSpMetadata(input: MetadataSpConstructor): SpMetadata {
  let xmlInput: string | Uint8Array;

  if (isString(input) || input instanceof Uint8Array) {
    xmlInput = input;
  } else {
    const {
      elementsOrder = ElementsOrder.default,
      entityID,
      signingCert,
      encryptCert,
      authnRequestsSigned = false,
      wantAssertionsSigned = false,
      wantMessageSigned = false,
      signatureConfig,
      nameIDFormat = [],
      singleLogoutService = [],
      assertionConsumerService = [],
    } = input;

    const descriptors: Record<string, XmlNode[]> = {
      KeyDescriptor: [],
      NameIDFormat: [],
      SingleLogoutService: [],
      AssertionConsumerService: [],
      AttributeConsumingService: [],
    };

    const SPSSODescriptor: XmlNode[] = [
      {
        _attr: {
          AuthnRequestsSigned: String(authnRequestsSigned),
          WantAssertionsSigned: String(wantAssertionsSigned),
          protocolSupportEnumeration: SamlNamespace.protocol,
        },
      },
    ];

    if (wantMessageSigned && signatureConfig === undefined) {
      console.warn("Construct service provider - missing signatureConfig");
    }

    for (const cert of castArrayOpt(signingCert)) {
      descriptors.KeyDescriptor.push(createKeySection("signing", cert).KeyDescriptor);
    }
    for (const cert of castArrayOpt(encryptCert)) {
      descriptors.KeyDescriptor.push(createKeySection("encryption", cert).KeyDescriptor);
    }

    if (isNonEmptyArray(nameIDFormat)) {
      nameIDFormat.forEach((f: string) => descriptors.NameIDFormat.push(f));
    } else {
      descriptors.NameIDFormat.push(NameIdFormat.emailAddress);
    }

    if (isNonEmptyArray(singleLogoutService)) {
      singleLogoutService.forEach((a) => {
        const attr: XmlObject = { Binding: a.Binding, Location: a.Location };
        if (a.isDefault) attr.isDefault = true;
        descriptors.SingleLogoutService.push([{ _attr: attr }]);
      });
    }

    if (isNonEmptyArray(assertionConsumerService)) {
      let indexCount = 0;
      assertionConsumerService.forEach((a) => {
        const attr: XmlObject = {
          index: String(indexCount++),
          Binding: a.Binding,
          Location: a.Location,
        };
        if (a.isDefault) attr.isDefault = true;
        descriptors.AssertionConsumerService.push([{ _attr: attr }]);
      });
    }

    const existedElements = elementsOrder.filter((name: string) =>
      isNonEmptyArray(descriptors[name]),
    );
    existedElements.forEach((name: string) => {
      descriptors[name].forEach((e) => SPSSODescriptor.push({ [name]: e }));
    });

    xmlInput = buildXml([
      {
        EntityDescriptor: [
          {
            _attr: {
              entityID,
              xmlns: SamlNamespace.metadata,
              "xmlns:assertion": SamlNamespace.assertion,
              "xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
            },
          },
          { SPSSODescriptor },
        ],
      },
    ]);
  }

  const { xmlString, meta } = parseBaseFields(xmlInput, [
    {
      key: "spSSODescriptor",
      localPath: ["EntityDescriptor", "SPSSODescriptor"],
      attributes: ["WantAssertionsSigned", "AuthnRequestsSigned"],
    },
    {
      key: "assertionConsumerService",
      localPath: ["EntityDescriptor", "SPSSODescriptor", "AssertionConsumerService"],
      attributes: ["Binding", "Location", "isDefault", "index"],
    },
  ]);

  return {
    xmlString,
    getMetadata: () => xmlString,
    getEntityID: () => metaString(meta, "entityID"),
    getX509Certificate: (use) => getX509Certificate(meta, use),
    getNameIDFormat: () => getNameIDFormat(meta),
    getSingleLogoutService: (binding) => getSingleLogoutService(meta, binding),
    isWantAssertionsSigned: () => readRecord(meta.spSSODescriptor)?.wantAssertionsSigned === "true",
    isAuthnRequestSigned: () => readRecord(meta.spSSODescriptor)?.authnRequestsSigned === "true",
    getAssertionConsumerService: (binding) => {
      if (isString(binding)) {
        const bindName = (BINDING_URI as Record<string, string>)[binding];
        const services = meta.assertionConsumerService;
        if (Array.isArray(services)) {
          const found = services.find(
            (obj): obj is AcsService => isAcsService(obj) && obj.binding === bindName,
          );
          return found?.location;
        }
        if (isAcsService(services) && services.binding === bindName) return services.location;
      }
      return meta.assertionConsumerService as string | string[] | undefined;
    },
  };
}
