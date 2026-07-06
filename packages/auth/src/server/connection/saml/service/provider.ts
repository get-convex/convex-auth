/** Service-provider entity factory. */

import { loginRequestRedirectURL, logoutResponseRedirectURL } from "../binding/redirect";
import { base64LoginRequest, base64LogoutResponse } from "../binding/post";
import { BINDING_URI } from "../constants";
import { DEFAULT_ENTITY_SETTINGS } from "../entity";
import { flow } from "../flow";
import { parseSpMetadata } from "../metadata";
import type { IdentityProviderEntity } from "../identity/provider";
import type { SpMetadata } from "../metadata";
import type {
  ServiceProviderSettings,
  SamlEntitySettings,
  SamlHttpRequest,
  BindingContext,
  PostBindingContext,
  SAMLDocumentTemplate,
} from "../types";
import type { FlowResult } from "../flow";

/**
 * The developer-supplied template-replacement callback. The SP contract receives the
 * raw template string; the redirect bindings nominally type the parameter as
 * {@link SAMLDocumentTemplate}, so the two call sites bridge it explicitly.
 */
type TagReplacement = (template: string) => BindingContext;

/**
 * The redirect bindings declare `customTagReplacement` over {@link SAMLDocumentTemplate}
 * rather than `string`. The callback never inspects the parameter's nominal shape, so the
 * bridge is type-only.
 */
function asDocumentTemplateReplacement(
  replacement: TagReplacement | undefined,
): ((template: SAMLDocumentTemplate) => BindingContext) | undefined {
  return replacement as ((template: SAMLDocumentTemplate) => BindingContext) | undefined;
}

/** A service-provider entity: its settings, metadata, and request/response builders and parsers. */
export interface ServiceProviderEntity {
  readonly entitySetting: SamlEntitySettings;
  readonly entityMeta: SpMetadata;
  getMetadata(): string;
  createLoginRequest(
    idp: IdentityProviderEntity,
    binding?: string,
    customTagReplacement?: TagReplacement,
  ): Promise<BindingContext | PostBindingContext>;
  parseLoginResponse(
    idp: IdentityProviderEntity,
    binding: string,
    request: SamlHttpRequest,
  ): Promise<FlowResult>;
  parseLogoutRequest(
    idp: IdentityProviderEntity,
    binding: string,
    request: SamlHttpRequest,
  ): Promise<FlowResult>;
  parseLogoutResponse(
    idp: IdentityProviderEntity,
    binding: string,
    request: SamlHttpRequest,
  ): Promise<FlowResult>;
  createLogoutResponse(
    target: IdentityProviderEntity,
    requestInfo: FlowResult,
    binding: string,
    relayState?: string,
    customTagReplacement?: TagReplacement,
  ): Promise<BindingContext | PostBindingContext>;
}

type BindingKey = keyof typeof BINDING_URI;

function isBindingKey(binding: string): binding is BindingKey {
  return Object.prototype.hasOwnProperty.call(BINDING_URI, binding);
}

function bindingProtocol(binding: string): string | undefined {
  return isBindingKey(binding) ? BINDING_URI[binding] : undefined;
}

/** Build an {@link ServiceProviderEntity} from service-provider settings or metadata. */
export function createServiceProvider(settings: ServiceProviderSettings): ServiceProviderEntity {
  const entitySetting: SamlEntitySettings = Object.assign(
    {},
    DEFAULT_ENTITY_SETTINGS,
    { authnRequestsSigned: false, wantAssertionsSigned: false, wantMessageSigned: false },
    settings,
    /** `Object.assign` yields a structural intersection; widen to the named, mutable SamlEntitySettings. */
  ) as SamlEntitySettings;

  const entityMeta = parseSpMetadata(settings.metadata ?? settings);
  entitySetting.authnRequestsSigned = entityMeta.isAuthnRequestSigned();
  entitySetting.wantAssertionsSigned = entityMeta.isWantAssertionsSigned();
  entitySetting.nameIDFormat = entityMeta.getNameIDFormat() || entitySetting.nameIDFormat;

  let sp: ServiceProviderEntity;

  sp = {
    entitySetting,
    entityMeta,

    getMetadata: () => entityMeta.getMetadata(),

    createLoginRequest: async (idp, binding = "redirect", customTagReplacement) => {
      const protocol = bindingProtocol(binding);
      if (entityMeta.isAuthnRequestSigned() !== idp.entityMeta.isWantAuthnRequestsSigned()) {
        throw new Error("ERR_METADATA_CONFLICT_REQUEST_SIGNED_FLAG");
      }
      if (protocol === BINDING_URI.redirect) {
        return loginRequestRedirectURL(
          { idp, sp },
          asDocumentTemplateReplacement(customTagReplacement),
        );
      }
      if (protocol === BINDING_URI.post) {
        const context = await base64LoginRequest(
          "/*[local-name(.)='AuthnRequest']",
          { idp, sp },
          customTagReplacement,
        );
        return {
          ...context,
          relayState: entitySetting.relayState,
          entityEndpoint: idp.entityMeta.getSingleSignOnService(binding),
          type: "SAMLRequest",
        };
      }
      throw new Error("ERR_SP_LOGIN_REQUEST_UNDEFINED_BINDING");
    },

    parseLoginResponse: (idp, binding, request) =>
      flow({
        from: idp,
        self: sp,
        checkSignature: true,
        parserType: "SAMLResponse",
        binding,
        request,
      }),

    parseLogoutRequest: (idp, binding, request) =>
      flow({
        from: idp,
        self: sp,
        parserType: "LogoutRequest",
        checkSignature: entitySetting.wantLogoutRequestSigned,
        binding,
        request,
      }),

    parseLogoutResponse: (idp, binding, request) =>
      flow({
        from: idp,
        self: sp,
        parserType: "LogoutResponse",
        checkSignature: entitySetting.wantLogoutResponseSigned,
        binding,
        request,
      }),

    createLogoutResponse: async (
      target,
      requestInfo,
      binding,
      relayState = "",
      customTagReplacement,
    ) => {
      const protocol = bindingProtocol(binding);
      if (protocol === BINDING_URI.redirect) {
        return logoutResponseRedirectURL(
          requestInfo,
          { init: sp, target },
          relayState,
          asDocumentTemplateReplacement(customTagReplacement),
        );
      }
      if (protocol === BINDING_URI.post) {
        const context = await base64LogoutResponse(
          requestInfo,
          { init: sp, target },
          /** The binding declares this parameter required; the SP contract has always
           * forwarded it optionally, preserving the prior pass-through behavior. */
          customTagReplacement as TagReplacement,
        );
        return {
          ...context,
          relayState,
          entityEndpoint: target.entityMeta.getSingleLogoutService(binding),
          type: "SAMLResponse",
        };
      }
      throw new Error("ERR_CREATE_LOGOUT_RESPONSE_UNDEFINED_BINDING");
    },
  };

  return sp;
}
