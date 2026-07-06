import { inflateString, base64Decode } from "./encoding";
import { getQueryParamByType } from "./template";
import { isValidXml } from "./api";
import { verifyMessageSignature, verifySignature } from "./signature";
import { decryptAssertion } from "./encryption";
import { verifyTime } from "./validator";
import {
  extract,
  asResponseExtract,
  loginRequestFields,
  loginResponseFields,
  logoutRequestFields,
  logoutResponseFields,
  ExtractorFields,
  logoutResponseStatusFields,
  loginResponseStatusFields,
  type SamlStatusExtract,
  type SamlAssertionExtract,
} from "./extractor";
import type { SamlMetadata } from "./metadata";
import type { SamlHttpRequest, SamlEntitySettings } from "./types";

import { SAML_STATUS_SUCCESS, type SamlMessageKind, type BindingKind } from "./constants";

/** Extracted SAML fields keyed by each extractor field's `key`. */
export type ExtractedProperties = Record<string, unknown>;

/** Outcome of parsing an inbound SAML message: raw XML, extracted fields, and signature algorithm. */
export interface FlowResult {
  samlContent: string;
  extract: ExtractedProperties;
  sigAlg?: string | null;
}

const extractorFieldsByMessageKind = new Map<
  SamlMessageKind,
  (assertion?: string | null) => ExtractorFields
>([
  ["SAMLRequest", () => loginRequestFields],
  [
    "SAMLResponse",
    (assertion) => {
      if (!assertion) {
        throw new Error("ERR_EMPTY_ASSERTION");
      }
      return loginResponseFields(assertion);
    },
  ],
  ["LogoutRequest", () => logoutRequestFields],
  ["LogoutResponse", () => logoutResponseFields],
]);

function getDefaultExtractorFields(parserType: string, assertion?: string | null): ExtractorFields {
  const resolve = extractorFieldsByMessageKind.get(parserType as SamlMessageKind);
  if (!resolve) {
    throw new Error("ERR_UNDEFINED_PARSERTYPE");
  }
  return resolve(assertion);
}

/** A SAML entity (the message peer or self), carrying its merged settings and parsed metadata. */
interface FlowEntity {
  entitySetting: SamlEntitySettings;
  entityMeta: SamlMetadata;
}

interface FlowOptions {
  from: FlowEntity;
  self: FlowEntity;
  request: SamlHttpRequest;
  parserType: string;
  binding: string;
  checkSignature?: boolean;
}

async function redirectFlow(options: FlowOptions): Promise<FlowResult> {
  const { request, parserType, self, checkSignature = true, from } = options;
  const { query, octetString } = request;

  if (query === undefined) {
    return Promise.reject("ERR_REDIRECT_FLOW_BAD_ARGS");
  }

  const { SigAlg: sigAlg, Signature: signature } = query;

  const targetEntityMetadata = from.entityMeta;

  const direction = getQueryParamByType(parserType);
  const content = query[direction];

  if (content === undefined) {
    return Promise.reject("ERR_REDIRECT_FLOW_BAD_ARGS");
  }

  const xmlString = inflateString(decodeURIComponent(content));

  try {
    await isValidXml(xmlString);
  } catch {
    return Promise.reject("ERR_INVALID_XML");
  }

  await checkStatus(xmlString, parserType);

  let assertion: string = "";

  if (parserType === "SAMLResponse") {
    const verifiedDoc = extract<SamlAssertionExtract>(xmlString, [
      {
        key: "assertion",
        localPath: ["~Response", "Assertion"],
        attributes: [],
        context: true,
      },
    ]);
    if (typeof verifiedDoc.assertion === "string") {
      assertion = verifiedDoc.assertion;
    }
  }

  const extractorFields = getDefaultExtractorFields(
    parserType,
    assertion.length > 0 ? assertion : null,
  );

  const parseResult: {
    samlContent: string;
    extract: ExtractedProperties;
    sigAlg: string | null;
  } = {
    samlContent: xmlString,
    sigAlg: null,
    extract: extract(xmlString, extractorFields),
  };

  if (checkSignature) {
    if (!signature || !sigAlg) {
      return Promise.reject("ERR_MISSING_SIG_ALG");
    }

    const base64Signature = decodeURIComponent(signature);
    const decodeSigAlg = decodeURIComponent(sigAlg);

    const verified = await verifyMessageSignature(
      targetEntityMetadata,
      octetString as string,
      base64Signature,
      sigAlg as string,
    );

    if (!verified) {
      return Promise.reject("ERR_FAILED_MESSAGE_SIGNATURE_VERIFICATION");
    }

    parseResult.sigAlg = decodeSigAlg;
  }

  const issuer = targetEntityMetadata.getEntityID();
  const extractedProperties = parseResult.extract;
  const response = asResponseExtract(extractedProperties);

  if (
    (parserType === "LogoutResponse" || parserType === "SAMLResponse") &&
    extractedProperties &&
    extractedProperties.issuer !== issuer
  ) {
    return Promise.reject("ERR_UNMATCH_ISSUER");
  }

  const sessionInfo = Array.isArray(response.sessionIndex)
    ? response.sessionIndex[0]
    : response.sessionIndex;
  if (
    parserType === "SAMLResponse" &&
    sessionInfo &&
    sessionInfo.sessionNotOnOrAfter &&
    !verifyTime(undefined, sessionInfo.sessionNotOnOrAfter, self.entitySetting.clockDrifts)
  ) {
    return Promise.reject("ERR_EXPIRED_SESSION");
  }

  if (
    parserType === "SAMLResponse" &&
    response.conditions &&
    !verifyTime(
      response.conditions.notBefore,
      response.conditions.notOnOrAfter,
      self.entitySetting.clockDrifts,
    )
  ) {
    return Promise.reject("ERR_SUBJECT_UNCONFIRMED");
  }

  return Promise.resolve(parseResult);
}

async function resolveAssertion(
  samlContent: string,
  verificationOptions: Parameters<typeof verifySignature>[1],
  decryptRequired: boolean | undefined,
  parserType: string,
  self: FlowEntity,
): Promise<{ samlContent: string; extractorFields: ExtractorFields }> {
  const [verified, verifiedAssertionNode] = await verifySignature(samlContent, verificationOptions);

  if (decryptRequired && verified && parserType === "SAMLResponse" && verifiedAssertionNode) {
    const result = await decryptAssertion(self, verifiedAssertionNode);
    return {
      samlContent: result[0],
      extractorFields: getDefaultExtractorFields(parserType, result[1]),
    };
  }

  if (decryptRequired && !verified) {
    const result = await decryptAssertion(self, samlContent);
    const decryptedDoc = result[0];
    const [decryptedDocVerified, verifiedDecryptedAssertion] = await verifySignature(
      decryptedDoc,
      verificationOptions,
    );
    if (decryptedDocVerified) {
      return {
        samlContent,
        extractorFields: getDefaultExtractorFields(parserType, verifiedDecryptedAssertion),
      };
    }
    throw "FAILED_TO_VERIFY_SIGNATURE";
  }

  if (verified) {
    return {
      samlContent,
      extractorFields: getDefaultExtractorFields(parserType, verifiedAssertionNode),
    };
  }

  throw "FAILED_TO_VERIFY_SIGNATURE";
}

async function postFlow(options: FlowOptions): Promise<FlowResult> {
  const { request, from, self, parserType, checkSignature = true } = options;

  const { body } = request;

  if (body === undefined) {
    return Promise.reject("ERR_POST_FLOW_BAD_ARGS");
  }

  const direction = getQueryParamByType(parserType);
  const encodedRequest = body[direction];

  if (encodedRequest === undefined) {
    return Promise.reject("ERR_POST_FLOW_BAD_ARGS");
  }

  let samlContent = String(base64Decode(encodedRequest));

  const verificationOptions = {
    metadata: from.entityMeta,
    signatureAlgorithm: from.entitySetting.requestSignatureAlgorithm,
  };

  const decryptRequired = from.entitySetting.isAssertionEncrypted;

  let extractorFields: ExtractorFields = [];

  await isValidXml(samlContent);

  if (parserType !== "SAMLResponse") {
    extractorFields = getDefaultExtractorFields(parserType, null);
  }

  await checkStatus(samlContent, parserType);

  if (checkSignature) {
    const resolved = await resolveAssertion(
      samlContent,
      verificationOptions,
      decryptRequired,
      parserType,
      self,
    );
    samlContent = resolved.samlContent;
    extractorFields = resolved.extractorFields;
  }

  const parseResult = {
    samlContent: samlContent,
    extract: extract(samlContent, extractorFields),
  };

  const targetEntityMetadata = from.entityMeta;
  const issuer = targetEntityMetadata.getEntityID();
  const extractedProperties = parseResult.extract;
  const response = asResponseExtract(extractedProperties);

  if (
    (parserType === "LogoutResponse" || parserType === "SAMLResponse") &&
    extractedProperties &&
    extractedProperties.issuer !== issuer
  ) {
    return Promise.reject("ERR_UNMATCH_ISSUER");
  }

  const sessionInfo = Array.isArray(response.sessionIndex)
    ? response.sessionIndex[0]
    : response.sessionIndex;
  if (
    parserType === "SAMLResponse" &&
    sessionInfo &&
    sessionInfo.sessionNotOnOrAfter &&
    !verifyTime(undefined, sessionInfo.sessionNotOnOrAfter, self.entitySetting.clockDrifts)
  ) {
    return Promise.reject("ERR_EXPIRED_SESSION");
  }

  if (
    parserType === "SAMLResponse" &&
    response.conditions &&
    !verifyTime(
      response.conditions.notBefore,
      response.conditions.notOnOrAfter,
      self.entitySetting.clockDrifts,
    )
  ) {
    return Promise.reject("ERR_SUBJECT_UNCONFIRMED");
  }

  return Promise.resolve(parseResult);
}

function checkStatus(content: string, parserType: string): Promise<string> {
  if (parserType !== "SAMLResponse" && parserType !== "LogoutResponse") {
    return Promise.resolve("SKIPPED");
  }

  const fields =
    parserType === "SAMLResponse" ? loginResponseStatusFields : logoutResponseStatusFields;

  const { top, second } = extract<SamlStatusExtract>(content, fields);

  if (top === SAML_STATUS_SUCCESS) {
    return Promise.resolve("OK");
  }

  if (!top) {
    throw new Error("ERR_UNDEFINED_STATUS");
  }

  throw new Error(`ERR_FAILED_STATUS with top tier code: ${top}, second tier code: ${second}`);
}

const flowByBinding: Record<BindingKind, (options: FlowOptions) => Promise<FlowResult>> = {
  post: postFlow,
  redirect: redirectFlow,
};

/** Dispatch an inbound SAML message to the redirect or POST parsing flow by binding. */
export function flow(options: FlowOptions): Promise<FlowResult> {
  if (options.parserType === "SAMLResponse" && options.binding === "redirect") {
    return Promise.reject("ERR_SAML_RESPONSE_REDIRECT_BINDING_FORBIDDEN");
  }
  const run = flowByBinding[options.binding as BindingKind];
  if (!run) {
    return Promise.reject("ERR_UNEXPECTED_FLOW");
  }
  return run(options);
}
