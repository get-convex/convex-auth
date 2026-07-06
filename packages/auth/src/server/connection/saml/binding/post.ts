/**
 * Binding-level API for functions using POST binding.
 */

import { SAML_STATUS_SUCCESS } from "../constants";
import type { BindingContext, SamlEntitySettings } from "../types";
import type { ExtractedProperties } from "../flow";
import {
  replaceTagsByValue,
  defaultLoginRequestTemplate,
  defaultLogoutResponseTemplate,
} from "../template";
import { constructSamlSignature } from "../signature";
import { get, base64Encode } from "../encoding";
import {
  getBindingField,
  type LoginEntity,
  type LogoutEntity,
  type LogoutResponseSetting,
} from "./shared";

/** The corresponding request whose parsed id seeds an `InResponseTo`. */
interface RequestInfoLike {
  extract?: ExtractedProperties;
}

/** Common signing fields spread into {@link constructSamlSignature}. */
interface SignatureBaseConfig {
  privateKey: string;
  privateKeyPass?: string;
  signatureAlgorithm: string;
  signingCert: string | Uint8Array;
  isBase64Output: boolean;
}

/**
 * Assemble the signing config from entity settings. The IdP signing path always
 * carries a configured `privateKey` and algorithm, and the signing certificate
 * resolves to a single PEM string. The signer declares these as `string` /
 * `string | Uint8Array`; the boundary casts narrow the optional `BinaryLike`
 * settings and the `string | string[] | null` certificate return to those
 * established types with no runtime change.
 */
function buildSignatureConfig(
  privateKey: SamlEntitySettings["privateKey"],
  privateKeyPass: SamlEntitySettings["privateKeyPass"],
  signatureAlgorithm: SamlEntitySettings["requestSignatureAlgorithm"],
  signingCert: string | string[] | null,
): SignatureBaseConfig {
  return {
    privateKey: privateKey as string,
    privateKeyPass,
    signatureAlgorithm: signatureAlgorithm as string,
    signingCert: signingCert as string | Uint8Array,
    isBase64Output: false,
  };
}

/** Generate a base64-encoded login request for the POST binding. */
export async function base64LoginRequest(
  referenceTagXPath: string,
  entity: LoginEntity,
  customTagReplacement?: (template: string) => BindingContext,
): Promise<BindingContext> {
  const metadata = { idp: entity.idp.entityMeta, sp: entity.sp.entityMeta };
  const spSetting = entity.sp.entitySetting;
  let id: string = "";

  if (metadata && metadata.idp && metadata.sp) {
    const base = metadata.idp.getSingleSignOnService("post");
    let rawSamlRequest: string;
    if (spSetting.loginRequestTemplate && customTagReplacement) {
      const info = customTagReplacement(spSetting.loginRequestTemplate.context!);
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
        AssertionConsumerServiceURL: metadata.sp.getAssertionConsumerService("post"),
        EntityID: metadata.sp.getEntityID(),
        AllowCreate: spSetting.allowCreate,
        NameIDFormat: selectedNameIDFormat,
      });
    }
    if (metadata.idp.isWantAuthnRequestsSigned()) {
      const {
        privateKey,
        privateKeyPass,
        requestSignatureAlgorithm: signatureAlgorithm,
        transformationAlgorithms,
      } = spSetting;
      return {
        id,
        context: await constructSamlSignature({
          ...buildSignatureConfig(
            privateKey,
            privateKeyPass,
            signatureAlgorithm,
            metadata.sp.getX509Certificate("signing"),
          ),
          referenceTagXPath,
          transformationAlgorithms,
          rawSamlMessage: rawSamlRequest,
          signatureConfig: spSetting.signatureConfig || {
            prefix: "ds",
            location: {
              reference: "/*[local-name(.)='AuthnRequest']/*[local-name(.)='Issuer']",
              action: "after",
            },
          },
        }),
      };
    }
    return {
      id,
      context: base64Encode(rawSamlRequest),
    };
  }
  throw new Error("ERR_GENERATE_POST_LOGIN_REQUEST_MISSING_METADATA");
}
/** Generate a base64-encoded logout response for the POST binding. */
export async function base64LogoutResponse(
  requestInfo: RequestInfoLike,
  entity: LogoutEntity,
  customTagReplacement: (template: string) => BindingContext,
): Promise<BindingContext> {
  const metadata = {
    init: entity.init.entityMeta,
    target: entity.target.entityMeta,
  };
  let id: string = "";
  const initSetting: LogoutResponseSetting = entity.init.entitySetting;
  if (metadata && metadata.init && metadata.target) {
    let rawSamlResponse: string;
    if (initSetting.logoutResponseTemplate) {
      const template = customTagReplacement(initSetting.logoutResponseTemplate.context!);
      id = template.id;
      rawSamlResponse = template.context;
    } else {
      id = initSetting.generateID!();
      const tvalue: Record<string, unknown> = {
        ID: id,
        Destination: metadata.target.getSingleLogoutService("post"),
        EntityID: metadata.init.getEntityID(),
        Issuer: metadata.init.getEntityID(),
        IssueInstant: new Date().toISOString(),
        StatusCode: SAML_STATUS_SUCCESS,
        InResponseTo: get(requestInfo, "extract.request.id", null),
      };
      rawSamlResponse = replaceTagsByValue(defaultLogoutResponseTemplate.context, tvalue);
    }
    if (entity.target.entitySetting.wantLogoutResponseSigned) {
      const {
        privateKey,
        privateKeyPass,
        requestSignatureAlgorithm: signatureAlgorithm,
        transformationAlgorithms,
      } = initSetting;
      return {
        id,
        context: await constructSamlSignature({
          ...buildSignatureConfig(
            privateKey,
            privateKeyPass,
            signatureAlgorithm,
            metadata.init.getX509Certificate("signing"),
          ),
          isMessageSigned: true,
          transformationAlgorithms: transformationAlgorithms,
          rawSamlMessage: rawSamlResponse,
          signatureConfig: {
            prefix: "ds",
            location: {
              reference: "/*[local-name(.)='LogoutResponse']/*[local-name(.)='Issuer']",
              action: "after",
            },
          },
        }),
      };
    }
    return {
      id,
      context: base64Encode(rawSamlResponse),
    };
  }
  throw new Error("ERR_GENERATE_POST_LOGOUT_RESPONSE_MISSING_METADATA");
}
