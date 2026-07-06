/** Identity-provider entity factory. */

import { DEFAULT_ENTITY_SETTINGS } from "../entity";
import { parseIdpMetadata } from "../metadata";
import { flow } from "../flow";
import {
  defaultAttributeStatementTemplate,
  defaultAttributeTemplate,
  attributeStatementBuilder,
  replaceTagsByValue,
} from "../template";
import { isString } from "../encoding";
import type { SamlMetadata, IdpMetadata } from "../metadata";
import type { IdentityProviderSettings, SamlEntitySettings, SamlHttpRequest } from "../types";
import type { FlowResult } from "../flow";

/** The counterparty (SP) entity supplied when an IdP parses an inbound message. */
interface CounterpartyEntity {
  entitySetting: SamlEntitySettings;
  entityMeta: SamlMetadata;
}

/** An identity-provider entity: its settings, parsed metadata, and message parsers. */
export interface IdentityProviderEntity {
  readonly entitySetting: SamlEntitySettings;
  readonly entityMeta: IdpMetadata;
  parseLoginResponse(
    from: CounterpartyEntity,
    binding: string,
    request: SamlHttpRequest,
  ): Promise<FlowResult>;
  parseLogoutRequest(
    from: CounterpartyEntity,
    binding: string,
    request: SamlHttpRequest,
  ): Promise<FlowResult>;
  parseLogoutResponse(
    from: CounterpartyEntity,
    binding: string,
    request: SamlHttpRequest,
  ): Promise<FlowResult>;
}

/** Build an {@link IdentityProviderEntity} from identity-provider settings or metadata. */
export function createIdentityProvider(settings: IdentityProviderSettings): IdentityProviderEntity {
  const defaultIdpSetting = {
    wantAuthnRequestsSigned: false,
    tagPrefix: { encryptedAssertion: "saml" },
  };

  let entitySetting: SamlEntitySettings = Object.assign(
    {},
    DEFAULT_ENTITY_SETTINGS,
    defaultIdpSetting,
    settings,
  );

  if (settings.loginResponseTemplate) {
    const tpl = settings.loginResponseTemplate;
    if (isString(tpl.context) && Array.isArray(tpl.attributes)) {
      const attributeStatementTemplate =
        tpl.additionalTemplates?.attributeStatementTemplate ?? defaultAttributeStatementTemplate;
      const attributeTemplate =
        tpl.additionalTemplates?.attributeTemplate ?? defaultAttributeTemplate;
      const replacement = {
        AttributeStatement: attributeStatementBuilder(
          tpl.attributes,
          attributeTemplate,
          attributeStatementTemplate,
        ),
      };
      entitySetting.loginResponseTemplate = {
        ...entitySetting.loginResponseTemplate,
        context: replaceTagsByValue(tpl.context, replacement),
      };
    } else {
      console.warn("Invalid login response template");
    }
  }

  const entityMeta = parseIdpMetadata(settings.metadata ?? settings);
  entitySetting.wantAuthnRequestsSigned = entityMeta.isWantAuthnRequestsSigned();
  entitySetting.nameIDFormat = entityMeta.getNameIDFormat() || entitySetting.nameIDFormat;

  const self = { entitySetting, entityMeta };

  return {
    entitySetting,
    entityMeta,
    parseLoginResponse: (from, binding, request) =>
      flow({
        from,
        self,
        checkSignature: true,
        parserType: "SAMLResponse",
        binding,
        request,
      }),
    parseLogoutRequest: (from, binding, request) =>
      flow({
        from,
        self,
        parserType: "LogoutRequest",
        checkSignature: entitySetting.wantLogoutRequestSigned,
        binding,
        request,
      }),
    parseLogoutResponse: (from, binding, request) =>
      flow({
        from,
        self,
        parserType: "LogoutResponse",
        checkSignature: entitySetting.wantLogoutResponseSigned,
        binding,
        request,
      }),
  };
}
