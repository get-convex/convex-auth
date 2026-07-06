/**
 * Binding-level API for functions using Redirect binding.
 */
import { base64Encode, deflateString } from "../encoding";
import {
  getQueryParamByType,
  replaceTagsByValue,
  defaultLoginRequestTemplate,
  defaultLogoutResponseTemplate,
} from "../template";
import { constructMessageSignature } from "../signature";
import type { BindingContext, SamlEntitySettings, SAMLDocumentTemplate } from "../types";
import type { FlowResult, ExtractedProperties } from "../flow";
import { SamlQueryParam, SAML_STATUS_SUCCESS } from "../constants";
import {
  getBindingField,
  type LoginEntity,
  type LogoutEntity,
  type LogoutResponseSetting,
} from "./shared";

/** Parsed request fields read from the genuinely-open {@link FlowResult.extract}. */
interface ParsedRequestExtract {
  request: { id: string };
}

/**
 * View the extractor's genuinely-open {@link ExtractedProperties} through the
 * concrete request shape these response/logout builders read. The extract is
 * dynamically assembled from inbound XML, so this is the single dynamic-shape
 * boundary where the open record is narrowed to {@link ParsedRequestExtract}.
 */
function asParsedRequest(extract: ExtractedProperties): ParsedRequestExtract {
  const value: unknown = extract;
  return value as ParsedRequestExtract;
}

interface BuildRedirectConfig {
  baseUrl: string;
  type: string;
  isSigned?: boolean;
  context: string;
  entitySetting: SamlEntitySettings;
  relayState?: string;
}

function pvPair(param: string, value: string, first?: boolean): string {
  return (first === true ? "?" : "&") + param + "=" + value;
}

function hasNoQuery(baseUrl: string): boolean {
  const queryIndex = baseUrl.indexOf("?");
  if (queryIndex < 0) {
    return true;
  }
  return queryIndex === baseUrl.length - 1;
}

/** Build the redirect-binding URL, optionally appending a query-string signature. */
async function buildRedirectURL(opts: BuildRedirectConfig): Promise<string> {
  const { baseUrl, type, isSigned, context, entitySetting } = opts;
  let { relayState = "" } = opts;
  const noParams = hasNoQuery(baseUrl);
  const queryParam = getQueryParamByType(type);
  const samlRequest = encodeURIComponent(base64Encode(deflateString(context)));
  if (relayState !== "") {
    relayState = pvPair(SamlQueryParam.relayState, encodeURIComponent(relayState));
  }
  if (isSigned) {
    /**
     * The signed redirect path always runs with a configured algorithm and key
     * (the entity defaults supply `requestSignatureAlgorithm`, and a signed
     * request requires `privateKey`); the signer also declares `privateKey` as
     * `string`. These two boundary casts narrow the optional/`BinaryLike`
     * settings to what the signer consumes without runtime change.
     */
    const sigAlg = pvPair(
      SamlQueryParam.sigAlg,
      encodeURIComponent(entitySetting.requestSignatureAlgorithm as string),
    );
    const octetString = samlRequest + relayState + sigAlg;
    const signature = await constructMessageSignature(
      queryParam + "=" + octetString,
      entitySetting.privateKey as string,
      entitySetting.privateKeyPass,
      undefined,
      entitySetting.requestSignatureAlgorithm,
    );
    return (
      baseUrl +
      pvPair(queryParam, octetString, noParams) +
      pvPair(SamlQueryParam.signature, encodeURIComponent(signature.toString()))
    );
  }
  return baseUrl + pvPair(queryParam, samlRequest + relayState, noParams);
}
/** Build the redirect-binding URL for a login request. */
export async function loginRequestRedirectURL(
  entity: LoginEntity,
  customTagReplacement?: (template: SAMLDocumentTemplate) => BindingContext,
): Promise<BindingContext> {
  const metadata = {
    idp: entity.idp.entityMeta,
    sp: entity.sp.entityMeta,
  };
  const spSetting: SamlEntitySettings = entity.sp.entitySetting;
  let id: string = "";

  if (metadata && metadata.idp && metadata.sp) {
    const base = metadata.idp.getSingleSignOnService("redirect") as string;
    let rawSamlRequest: string;
    if (spSetting.loginRequestTemplate && customTagReplacement) {
      const info = customTagReplacement(spSetting.loginRequestTemplate);
      id = getBindingField(info, "id");
      rawSamlRequest = getBindingField(info, "context");
    } else {
      const nameIDFormat = spSetting.nameIDFormat;
      const selectedNameIDFormat = Array.isArray(nameIDFormat) ? nameIDFormat[0] : nameIDFormat;
      id = spSetting.generateID!();
      rawSamlRequest = replaceTagsByValue(defaultLoginRequestTemplate.context, {
        ID: id,
        Destination: base,
        Issuer: metadata.sp.getEntityID(),
        IssueInstant: new Date().toISOString(),
        NameIDFormat: selectedNameIDFormat,
        AssertionConsumerServiceURL: metadata.sp.getAssertionConsumerService("post"),
        EntityID: metadata.sp.getEntityID(),
        AllowCreate: spSetting.allowCreate,
      });
    }
    return {
      id,
      context: await buildRedirectURL({
        context: rawSamlRequest,
        type: "SAMLRequest",
        isSigned: metadata.sp.isAuthnRequestSigned(),
        entitySetting: spSetting,
        baseUrl: base,
        relayState: spSetting.relayState,
      }),
    };
  }
  throw new Error("ERR_GENERATE_REDIRECT_LOGIN_REQUEST_MISSING_METADATA");
}
/** Build the redirect-binding URL for a logout response. */
export async function logoutResponseRedirectURL(
  requestInfo: FlowResult | null,
  entity: LogoutEntity,
  relayState?: string,
  customTagReplacement?: (template: SAMLDocumentTemplate) => BindingContext,
): Promise<BindingContext> {
  const metadata = {
    init: entity.init.entityMeta,
    target: entity.target.entityMeta,
  };
  const initSetting: LogoutResponseSetting = entity.init.entitySetting;
  let id: string = initSetting.generateID!();
  if (metadata && metadata.init && metadata.target) {
    const base = metadata.target.getSingleLogoutService("redirect") as string;
    let rawSamlResponse: string;
    if (initSetting.logoutResponseTemplate && customTagReplacement) {
      const template = customTagReplacement(initSetting.logoutResponseTemplate);
      id = getBindingField(template, "id");
      rawSamlResponse = getBindingField(template, "context");
    } else {
      const tvalue: Record<string, unknown> = {
        ID: id,
        Destination: base,
        Issuer: metadata.init.getEntityID(),
        EntityID: metadata.init.getEntityID(),
        IssueInstant: new Date().toISOString(),
        StatusCode: SAML_STATUS_SUCCESS,
      };
      if (requestInfo && requestInfo.extract && asParsedRequest(requestInfo.extract).request) {
        tvalue.InResponseTo = asParsedRequest(requestInfo.extract).request.id;
      }
      rawSamlResponse = replaceTagsByValue(defaultLogoutResponseTemplate.context, tvalue);
    }
    return {
      id,
      context: await buildRedirectURL({
        baseUrl: base,
        type: "LogoutResponse",
        isSigned: entity.target.entitySetting.wantLogoutResponseSigned,
        context: rawSamlResponse,
        entitySetting: initSetting,
        relayState,
      }),
    };
  }
  throw new Error("ERR_GENERATE_REDIRECT_LOGOUT_RESPONSE_MISSING_METADATA");
}
