/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  account: {
    create: FunctionReference<
      "mutation",
      "internal",
      {
        extend?: any;
        provider: string;
        providerAccountId: string;
        secret?: string;
        userId: string;
      },
      string,
      Name
    >;
    get: FunctionReference<
      "query",
      "internal",
      { id?: string; provider?: string; providerAccountId?: string },
      {
        _creationTime: number;
        _id: string;
        emailVerified?: string;
        extend?: any;
        phoneVerified?: string;
        provider: string;
        providerAccountId: string;
        secret?: string;
        userId: string;
      } | null,
      Name
    >;
    list: FunctionReference<
      "query",
      "internal",
      { userId: string },
      Array<{
        _creationTime: number;
        _id: string;
        emailVerified?: string;
        extend?: any;
        phoneVerified?: string;
        provider: string;
        providerAccountId: string;
        secret?: string;
        userId: string;
      }>,
      Name
    >;
    remove: FunctionReference<
      "mutation",
      "internal",
      { id: string; requireOtherAccount?: boolean },
      null,
      Name
    >;
    update: FunctionReference<
      "mutation",
      "internal",
      {
        id: string;
        patch: {
          emailVerified?: string;
          extend?: any;
          phoneVerified?: string;
          provider?: string;
          providerAccountId?: string;
          secret?: string;
          userId?: string;
        };
      },
      null,
      Name
    >;
  };
  connection: {
    audit: {
      list: FunctionReference<
        "query",
        "internal",
        {
          connectionId?: string;
          groupId?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            actorId?: string;
            actorType:
              | "user"
              | "system"
              | "scim"
              | "api_key"
              | "oauth_client"
              | "webhook"
              | "anonymous";
            category:
              | "user"
              | "session"
              | "account"
              | "password"
              | "passkey"
              | "totp"
              | "email"
              | "phone"
              | "api_key"
              | "oauth"
              | "connection"
              | "scim"
              | "webhook"
              | "security";
            data?:
              | {
                  existingUserId?: string;
                  profile?: Record<string, any>;
                  provider?: string;
                  type?: string;
                }
              | { method?: string; provider: string }
              | {
                  flow?: "reset" | "change";
                  reason?: string;
                  refreshTokenId?: string;
                  sessionId?: string;
                  userId?: string;
                }
              | {
                  accountId?: string;
                  provider?: string;
                  providerAccountId?: string;
                }
              | {
                  credentialId?: string;
                  keyId?: string;
                  name?: string;
                  passkeyId?: string;
                  prefix?: string;
                  totpId?: string;
                }
              | { email?: string; phone?: string; userId?: string }
              | {
                  clientId?: string;
                  codeId?: string;
                  grantType?: string;
                  name?: string;
                  redirectUri?: string;
                  resource?: string;
                  scopes?: Array<string>;
                  userId?: string;
                }
              | {
                  audience?: string | Array<string>;
                  connectionId?: string;
                  discoveryUrl?: string;
                  domain?: string;
                  domains?: Array<string>;
                  errorCode?: string;
                  expiresAt?: number;
                  issuer?: string;
                  jwksUri?: string;
                  metadataUrl?: string;
                  protocol?: "oidc" | "saml";
                  recordName?: string;
                  tokenEndpointAuthMethod?: string;
                  verifiedAt?: number;
                  version?: number;
                }
              | {
                  active?: boolean;
                  externalId?: string;
                  groupId?: string;
                  operation?: string;
                  resourceId?: string;
                  resourceType?: "user" | "group";
                  scimConfigId?: string;
                  userId?: string;
                }
              | {
                  attemptCount?: number;
                  deliveryId?: string;
                  endpointId?: string;
                  error?: string;
                  sourceEventId?: string;
                  sourceEventType?:
                    | "user.created"
                    | "user.updated"
                    | "session.signed_in"
                    | "session.signed_out"
                    | "session.invalidated"
                    | "session.refresh_exchanged"
                    | "session.refresh_reuse_detected"
                    | "account.linked"
                    | "account.unlinked"
                    | "password.changed"
                    | "passkey.added"
                    | "passkey.removed"
                    | "totp.enrolled"
                    | "totp.removed"
                    | "email.verified"
                    | "phone.verified"
                    | "api_key.created"
                    | "api_key.revoked"
                    | "oauth.client.created"
                    | "oauth.client.revoked"
                    | "oauth.code.created"
                    | "oauth.token.created"
                    | "oauth.token.exchanged"
                    | "oauth.refresh.reuse_detected"
                    | "oauth.refresh.revoked"
                    | "connection.created"
                    | "connection.updated"
                    | "connection.removed"
                    | "connection.login.succeeded"
                    | "connection.login.failed"
                    | "connection.domain.verification_requested"
                    | "connection.domain.verified"
                    | "connection.policy.updated"
                    | "connection.saml.set"
                    | "connection.saml.refreshed"
                    | "connection.oidc.set"
                    | "connection.scim.set"
                    | "connection.scim.read"
                    | "connection.scim.user.provisioned"
                    | "connection.scim.user.updated"
                    | "connection.scim.user.deactivated"
                    | "connection.scim.user.reactivated"
                    | "connection.scim.group.provisioned"
                    | "connection.scim.group.updated"
                    | "connection.scim.group.deactivated"
                    | "connection.scim.group.reactivated"
                    | "webhook.endpoint.created"
                    | "webhook.endpoint.disabled"
                    | "webhook.delivery.created"
                    | "webhook.delivery.attempted"
                    | "webhook.delivery.succeeded"
                    | "webhook.delivery.failed";
                  status?: number;
                };
            errorCode?: string;
            eventId: string;
            ip?: string;
            kind:
              | "user.created"
              | "user.updated"
              | "session.signed_in"
              | "session.signed_out"
              | "session.invalidated"
              | "session.refresh_exchanged"
              | "session.refresh_reuse_detected"
              | "account.linked"
              | "account.unlinked"
              | "password.changed"
              | "passkey.added"
              | "passkey.removed"
              | "totp.enrolled"
              | "totp.removed"
              | "email.verified"
              | "phone.verified"
              | "api_key.created"
              | "api_key.revoked"
              | "oauth.client.created"
              | "oauth.client.revoked"
              | "oauth.code.created"
              | "oauth.token.created"
              | "oauth.token.exchanged"
              | "oauth.refresh.reuse_detected"
              | "oauth.refresh.revoked"
              | "connection.created"
              | "connection.updated"
              | "connection.removed"
              | "connection.login.succeeded"
              | "connection.login.failed"
              | "connection.domain.verification_requested"
              | "connection.domain.verified"
              | "connection.policy.updated"
              | "connection.saml.set"
              | "connection.saml.refreshed"
              | "connection.oidc.set"
              | "connection.scim.set"
              | "connection.scim.read"
              | "connection.scim.user.provisioned"
              | "connection.scim.user.updated"
              | "connection.scim.user.deactivated"
              | "connection.scim.user.reactivated"
              | "connection.scim.group.provisioned"
              | "connection.scim.group.updated"
              | "connection.scim.group.deactivated"
              | "connection.scim.group.reactivated"
              | "webhook.endpoint.created"
              | "webhook.endpoint.disabled"
              | "webhook.delivery.created"
              | "webhook.delivery.attempted"
              | "webhook.delivery.succeeded"
              | "webhook.delivery.failed";
            occurredAt: number;
            outcome: "success" | "failure";
            requestId?: string;
            subjectId?: string;
            subjectType:
              | "user"
              | "session"
              | "account"
              | "passkey"
              | "totp"
              | "email"
              | "phone"
              | "api_key"
              | "oauth_client"
              | "oauth_code"
              | "group"
              | "connection"
              | "scim_identity"
              | "webhook_endpoint"
              | "webhook_delivery"
              | "system";
            targetId: string;
            targetKind:
              | "user"
              | "session"
              | "group"
              | "connection"
              | "oauth_client"
              | "api_key"
              | "global";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
    cache: {
      invalidateOidcDiscovery: FunctionReference<
        "mutation",
        "internal",
        { externalHost?: string; runtimeOrigin?: string; url: string },
        null,
        Name
      >;
      invalidateSamlMetadata: FunctionReference<
        "mutation",
        "internal",
        { externalHost?: string; runtimeOrigin?: string; url: string },
        null,
        Name
      >;
      oidcDiscovery: FunctionReference<
        "action",
        "internal",
        { externalHost?: string; runtimeOrigin?: string; url: string },
        {
          authorization_endpoint: string;
          id_token_signing_alg_values_supported?: Array<string>;
          issuer: string;
          jwks_uri: string;
          token_endpoint: string;
          token_endpoint_auth_methods_supported?: Array<string>;
          userinfo_endpoint?: string;
        },
        Name
      >;
      oidcStatusDiscovery: FunctionReference<
        "action",
        "internal",
        { externalHost?: string; runtimeOrigin?: string; url: string },
        {
          authorization_endpoint: string;
          id_token_signing_alg_values_supported?: Array<string>;
          issuer: string;
          jwks_uri: string;
          token_endpoint: string;
          token_endpoint_auth_methods_supported?: Array<string>;
          userinfo_endpoint?: string;
        },
        Name
      >;
      samlMetadata: FunctionReference<
        "action",
        "internal",
        { externalHost?: string; runtimeOrigin?: string; url: string },
        string,
        Name
      >;
    };
    create: FunctionReference<
      "mutation",
      "internal",
      {
        config?: any;
        extend?: any;
        groupId: string;
        name?: string;
        protocol: "oidc" | "saml";
        slug?: string;
        status?: "draft" | "active" | "disabled";
      },
      string,
      Name
    >;
    domain: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          connectionId: string;
          domain: string;
          groupId: string;
          isPrimary?: boolean;
        },
        string,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { connectionId: string; limit?: number },
        Array<{
          _creationTime: number;
          _id: string;
          connectionId: string;
          domain: string;
          groupId: string;
          isPrimary: boolean;
          verifiedAt?: number;
        }>,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      verification: {
        get: FunctionReference<
          "query",
          "internal",
          { domainId: string },
          {
            _creationTime: number;
            _id: string;
            connectionId: string;
            domain: string;
            domainId: string;
            expiresAt: number;
            groupId: string;
            recordName: string;
            requestedAt: number;
            token: string;
            tokenHash: string;
          } | null,
          Name
        >;
        remove: FunctionReference<"mutation", "internal", { domainId: string }, null, Name>;
        upsert: FunctionReference<
          "mutation",
          "internal",
          {
            connectionId: string;
            domain: string;
            domainId: string;
            expiresAt: number;
            groupId: string;
            recordName: string;
            requestedAt: number;
            token: string;
            tokenHash: string;
          },
          string,
          Name
        >;
      };
      verify: FunctionReference<
        "mutation",
        "internal",
        { id: string; verifiedAt: number },
        {
          _creationTime: number;
          _id: string;
          connectionId: string;
          domain: string;
          groupId: string;
          isPrimary: boolean;
          verifiedAt?: number;
        },
        Name
      >;
    };
    get: FunctionReference<
      "query",
      "internal",
      { domain?: string; id?: string },
      | {
          _creationTime: number;
          _id: string;
          config?: any;
          extend?: any;
          groupId: string;
          name?: string;
          protocol: "oidc" | "saml";
          slug?: string;
          status: "draft" | "active" | "disabled";
        }
      | {
          connection: {
            _creationTime: number;
            _id: string;
            config?: any;
            extend?: any;
            groupId: string;
            name?: string;
            protocol: "oidc" | "saml";
            slug?: string;
            status: "draft" | "active" | "disabled";
          };
          domain: {
            _creationTime: number;
            _id: string;
            connectionId: string;
            domain: string;
            groupId: string;
            isPrimary: boolean;
            verifiedAt?: number;
          };
        }
      | null,
      Name
    >;
    list: FunctionReference<
      "query",
      "internal",
      {
        order?: "asc" | "desc";
        orderBy?: "_creationTime" | "name" | "slug" | "status";
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        where?: {
          groupId?: string;
          slug?: string;
          status?: "draft" | "active" | "disabled";
        };
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: string;
          config?: any;
          extend?: any;
          groupId: string;
          name?: string;
          protocol: "oidc" | "saml";
          slug?: string;
          status: "draft" | "active" | "disabled";
        }>;
        pageStatus?: "SplitRecommended" | "SplitRequired" | null;
        splitCursor?: string | null;
      },
      Name
    >;
    remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
    saml: {
      assertion: {
        accept: FunctionReference<
          "mutation",
          "internal",
          { assertionId: string; connectionId: string; expiresAt: number },
          boolean,
          Name
        >;
      };
      request: {
        accept: FunctionReference<
          "mutation",
          "internal",
          { connectionId?: string; now: number; requestId: string },
          boolean,
          Name
        >;
        create: FunctionReference<
          "mutation",
          "internal",
          {
            connectionId: string;
            createdAt: number;
            expiresAt: number;
            requestId: string;
          },
          string,
          Name
        >;
      };
    };
    scim: {
      config: {
        get: FunctionReference<
          "query",
          "internal",
          { connectionId?: string; tokenHash?: string },
          {
            _creationTime: number;
            _id: string;
            basePath: string;
            connectionId: string;
            extend?: any;
            groupId: string;
            lastRotatedAt?: number;
            status: "draft" | "active" | "disabled";
            tokenHash: string;
          } | null,
          Name
        >;
        upsert: FunctionReference<
          "mutation",
          "internal",
          {
            basePath: string;
            connectionId: string;
            extend?: any;
            groupId: string;
            lastRotatedAt?: number;
            status: "draft" | "active" | "disabled";
            tokenHash: string;
          },
          string,
          Name
        >;
      };
      identity: {
        get: FunctionReference<
          "query",
          "internal",
          {
            connectionId?: string;
            externalId?: string;
            mappedGroupId?: string;
            resourceType?: "user" | "group";
            userId?: string;
            userIds?: Array<string>;
          },
          | {
              _creationTime: number;
              _id: string;
              active?: boolean;
              connectionId: string;
              externalId: string;
              groupId: string;
              lastProvisionedAt?: number;
              mappedGroupId?: string;
              raw?: any;
              resourceType: "user" | "group";
              userId?: string;
            }
          | null
          | Array<{
              _creationTime: number;
              _id: string;
              active?: boolean;
              connectionId: string;
              externalId: string;
              groupId: string;
              lastProvisionedAt?: number;
              mappedGroupId?: string;
              raw?: any;
              resourceType: "user" | "group";
              userId?: string;
            } | null>,
          Name
        >;
        list: FunctionReference<
          "query",
          "internal",
          {
            connectionId: string;
            paginationOpts: {
              cursor: string | null;
              endCursor?: string | null;
              id?: number;
              maximumBytesRead?: number;
              maximumRowsRead?: number;
              numItems: number;
            };
          },
          {
            continueCursor: string;
            isDone: boolean;
            page: Array<{
              _creationTime: number;
              _id: string;
              active?: boolean;
              connectionId: string;
              externalId: string;
              groupId: string;
              lastProvisionedAt?: number;
              mappedGroupId?: string;
              raw?: any;
              resourceType: "user" | "group";
              userId?: string;
            }>;
            pageStatus?: "SplitRecommended" | "SplitRequired" | null;
            splitCursor?: string | null;
          },
          Name
        >;
        remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
        upsert: FunctionReference<
          "mutation",
          "internal",
          {
            active?: boolean;
            connectionId: string;
            externalId: string;
            groupId: string;
            lastProvisionedAt?: number;
            mappedGroupId?: string;
            raw?: any;
            resourceType: "user" | "group";
            userId?: string;
          },
          string,
          Name
        >;
      };
    };
    secret: {
      get: FunctionReference<
        "query",
        "internal",
        { connectionId: string; kind: "oidc_client_secret" },
        {
          _creationTime: number;
          _id: string;
          ciphertext: string;
          connectionId: string;
          groupId: string;
          kind: "oidc_client_secret";
          updatedAt: number;
        } | null,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { connectionId: string; kind: "oidc_client_secret" },
        null,
        Name
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        {
          ciphertext: string;
          connectionId: string;
          groupId: string;
          kind: "oidc_client_secret";
          updatedAt: number;
        },
        string,
        Name
      >;
    };
    update: FunctionReference<
      "mutation",
      "internal",
      {
        id: string;
        patch: {
          config?: any;
          extend?: any;
          name?: string;
          slug?: string;
          status?: "draft" | "active" | "disabled";
        };
      },
      null,
      Name
    >;
    webhook: {
      delivery: {
        create: FunctionReference<
          "mutation",
          "internal",
          {
            connectionId: string;
            endpointId: string;
            eventId: string;
            kind:
              | "user.created"
              | "user.updated"
              | "session.signed_in"
              | "session.signed_out"
              | "session.invalidated"
              | "session.refresh_exchanged"
              | "session.refresh_reuse_detected"
              | "account.linked"
              | "account.unlinked"
              | "password.changed"
              | "passkey.added"
              | "passkey.removed"
              | "totp.enrolled"
              | "totp.removed"
              | "email.verified"
              | "phone.verified"
              | "api_key.created"
              | "api_key.revoked"
              | "oauth.client.created"
              | "oauth.client.revoked"
              | "oauth.code.created"
              | "oauth.token.created"
              | "oauth.token.exchanged"
              | "oauth.refresh.reuse_detected"
              | "oauth.refresh.revoked"
              | "connection.created"
              | "connection.updated"
              | "connection.removed"
              | "connection.login.succeeded"
              | "connection.login.failed"
              | "connection.domain.verification_requested"
              | "connection.domain.verified"
              | "connection.policy.updated"
              | "connection.saml.set"
              | "connection.saml.refreshed"
              | "connection.oidc.set"
              | "connection.scim.set"
              | "connection.scim.read"
              | "connection.scim.user.provisioned"
              | "connection.scim.user.updated"
              | "connection.scim.user.deactivated"
              | "connection.scim.user.reactivated"
              | "connection.scim.group.provisioned"
              | "connection.scim.group.updated"
              | "connection.scim.group.deactivated"
              | "connection.scim.group.reactivated"
              | "webhook.endpoint.created"
              | "webhook.endpoint.disabled"
              | "webhook.delivery.created"
              | "webhook.delivery.attempted"
              | "webhook.delivery.succeeded"
              | "webhook.delivery.failed";
            nextAttemptAt: number;
            payload: any;
            signature: string;
            signedAt: number;
          },
          string,
          Name
        >;
        dueForDispatch: FunctionReference<
          "query",
          "internal",
          { limit?: number; now: number },
          Array<{
            _creationTime: number;
            _id: string;
            attemptCount: number;
            connectionId: string;
            endpointId: string;
            eventId: string;
            kind:
              | "user.created"
              | "user.updated"
              | "session.signed_in"
              | "session.signed_out"
              | "session.invalidated"
              | "session.refresh_exchanged"
              | "session.refresh_reuse_detected"
              | "account.linked"
              | "account.unlinked"
              | "password.changed"
              | "passkey.added"
              | "passkey.removed"
              | "totp.enrolled"
              | "totp.removed"
              | "email.verified"
              | "phone.verified"
              | "api_key.created"
              | "api_key.revoked"
              | "oauth.client.created"
              | "oauth.client.revoked"
              | "oauth.code.created"
              | "oauth.token.created"
              | "oauth.token.exchanged"
              | "oauth.refresh.reuse_detected"
              | "oauth.refresh.revoked"
              | "connection.created"
              | "connection.updated"
              | "connection.removed"
              | "connection.login.succeeded"
              | "connection.login.failed"
              | "connection.domain.verification_requested"
              | "connection.domain.verified"
              | "connection.policy.updated"
              | "connection.saml.set"
              | "connection.saml.refreshed"
              | "connection.oidc.set"
              | "connection.scim.set"
              | "connection.scim.read"
              | "connection.scim.user.provisioned"
              | "connection.scim.user.updated"
              | "connection.scim.user.deactivated"
              | "connection.scim.user.reactivated"
              | "connection.scim.group.provisioned"
              | "connection.scim.group.updated"
              | "connection.scim.group.deactivated"
              | "connection.scim.group.reactivated"
              | "webhook.endpoint.created"
              | "webhook.endpoint.disabled"
              | "webhook.delivery.created"
              | "webhook.delivery.attempted"
              | "webhook.delivery.succeeded"
              | "webhook.delivery.failed";
            lastAttemptAt?: number;
            lastError?: string;
            lastResponseStatus?: number;
            nextAttemptAt: number;
            payload: any;
            signature: string;
            signedAt: number;
            status: "pending" | "processing" | "delivered" | "failed";
          }>,
          Name
        >;
        list: FunctionReference<
          "query",
          "internal",
          {
            connectionId: string;
            paginationOpts: {
              cursor: string | null;
              endCursor?: string | null;
              id?: number;
              maximumBytesRead?: number;
              maximumRowsRead?: number;
              numItems: number;
            };
          },
          {
            continueCursor: string;
            isDone: boolean;
            page: Array<{
              _creationTime: number;
              _id: string;
              attemptCount: number;
              connectionId: string;
              endpointId: string;
              eventId: string;
              kind:
                | "user.created"
                | "user.updated"
                | "session.signed_in"
                | "session.signed_out"
                | "session.invalidated"
                | "session.refresh_exchanged"
                | "session.refresh_reuse_detected"
                | "account.linked"
                | "account.unlinked"
                | "password.changed"
                | "passkey.added"
                | "passkey.removed"
                | "totp.enrolled"
                | "totp.removed"
                | "email.verified"
                | "phone.verified"
                | "api_key.created"
                | "api_key.revoked"
                | "oauth.client.created"
                | "oauth.client.revoked"
                | "oauth.code.created"
                | "oauth.token.created"
                | "oauth.token.exchanged"
                | "oauth.refresh.reuse_detected"
                | "oauth.refresh.revoked"
                | "connection.created"
                | "connection.updated"
                | "connection.removed"
                | "connection.login.succeeded"
                | "connection.login.failed"
                | "connection.domain.verification_requested"
                | "connection.domain.verified"
                | "connection.policy.updated"
                | "connection.saml.set"
                | "connection.saml.refreshed"
                | "connection.oidc.set"
                | "connection.scim.set"
                | "connection.scim.read"
                | "connection.scim.user.provisioned"
                | "connection.scim.user.updated"
                | "connection.scim.user.deactivated"
                | "connection.scim.user.reactivated"
                | "connection.scim.group.provisioned"
                | "connection.scim.group.updated"
                | "connection.scim.group.deactivated"
                | "connection.scim.group.reactivated"
                | "webhook.endpoint.created"
                | "webhook.endpoint.disabled"
                | "webhook.delivery.created"
                | "webhook.delivery.attempted"
                | "webhook.delivery.succeeded"
                | "webhook.delivery.failed";
              lastAttemptAt?: number;
              lastError?: string;
              lastResponseStatus?: number;
              nextAttemptAt: number;
              signedAt: number;
              status: "pending" | "processing" | "delivered" | "failed";
            }>;
            pageStatus?: "SplitRecommended" | "SplitRequired" | null;
            splitCursor?: string | null;
          },
          Name
        >;
        update: FunctionReference<
          "mutation",
          "internal",
          {
            id: string;
            patch: {
              attemptCount?: number;
              lastAttemptAt?: number;
              lastError?: string;
              lastResponseStatus?: number;
              nextAttemptAt?: number;
              status?: "pending" | "processing" | "delivered" | "failed";
            };
          },
          null,
          Name
        >;
      };
      endpoint: {
        create: FunctionReference<
          "mutation",
          "internal",
          {
            connectionId: string;
            createdByUserId?: string;
            extend?: any;
            groupId: string;
            secretCiphertext: string;
            status?: "active" | "disabled";
            subscriptions: Array<
              | "user.created"
              | "user.updated"
              | "session.signed_in"
              | "session.signed_out"
              | "session.invalidated"
              | "session.refresh_exchanged"
              | "session.refresh_reuse_detected"
              | "account.linked"
              | "account.unlinked"
              | "password.changed"
              | "passkey.added"
              | "passkey.removed"
              | "totp.enrolled"
              | "totp.removed"
              | "email.verified"
              | "phone.verified"
              | "api_key.created"
              | "api_key.revoked"
              | "oauth.client.created"
              | "oauth.client.revoked"
              | "oauth.code.created"
              | "oauth.token.created"
              | "oauth.token.exchanged"
              | "oauth.refresh.reuse_detected"
              | "oauth.refresh.revoked"
              | "connection.created"
              | "connection.updated"
              | "connection.removed"
              | "connection.login.succeeded"
              | "connection.login.failed"
              | "connection.domain.verification_requested"
              | "connection.domain.verified"
              | "connection.policy.updated"
              | "connection.saml.set"
              | "connection.saml.refreshed"
              | "connection.oidc.set"
              | "connection.scim.set"
              | "connection.scim.read"
              | "connection.scim.user.provisioned"
              | "connection.scim.user.updated"
              | "connection.scim.user.deactivated"
              | "connection.scim.user.reactivated"
              | "connection.scim.group.provisioned"
              | "connection.scim.group.updated"
              | "connection.scim.group.deactivated"
              | "connection.scim.group.reactivated"
              | "webhook.endpoint.created"
              | "webhook.endpoint.disabled"
              | "webhook.delivery.created"
              | "webhook.delivery.attempted"
              | "webhook.delivery.succeeded"
              | "webhook.delivery.failed"
            >;
            url: string;
          },
          string,
          Name
        >;
        get: FunctionReference<
          "query",
          "internal",
          { id: string },
          {
            _creationTime: number;
            _id: string;
            connectionId: string;
            createdByUserId?: string;
            extend?: any;
            failureCount: number;
            groupId: string;
            lastFailureAt?: number;
            lastSuccessAt?: number;
            secretCiphertext: string;
            status: "active" | "disabled";
            subscriptions: Array<
              | "user.created"
              | "user.updated"
              | "session.signed_in"
              | "session.signed_out"
              | "session.invalidated"
              | "session.refresh_exchanged"
              | "session.refresh_reuse_detected"
              | "account.linked"
              | "account.unlinked"
              | "password.changed"
              | "passkey.added"
              | "passkey.removed"
              | "totp.enrolled"
              | "totp.removed"
              | "email.verified"
              | "phone.verified"
              | "api_key.created"
              | "api_key.revoked"
              | "oauth.client.created"
              | "oauth.client.revoked"
              | "oauth.code.created"
              | "oauth.token.created"
              | "oauth.token.exchanged"
              | "oauth.refresh.reuse_detected"
              | "oauth.refresh.revoked"
              | "connection.created"
              | "connection.updated"
              | "connection.removed"
              | "connection.login.succeeded"
              | "connection.login.failed"
              | "connection.domain.verification_requested"
              | "connection.domain.verified"
              | "connection.policy.updated"
              | "connection.saml.set"
              | "connection.saml.refreshed"
              | "connection.oidc.set"
              | "connection.scim.set"
              | "connection.scim.read"
              | "connection.scim.user.provisioned"
              | "connection.scim.user.updated"
              | "connection.scim.user.deactivated"
              | "connection.scim.user.reactivated"
              | "connection.scim.group.provisioned"
              | "connection.scim.group.updated"
              | "connection.scim.group.deactivated"
              | "connection.scim.group.reactivated"
              | "webhook.endpoint.created"
              | "webhook.endpoint.disabled"
              | "webhook.delivery.created"
              | "webhook.delivery.attempted"
              | "webhook.delivery.succeeded"
              | "webhook.delivery.failed"
            >;
            url: string;
          } | null,
          Name
        >;
        list: FunctionReference<
          "query",
          "internal",
          { connectionId: string },
          Array<{
            _creationTime: number;
            _id: string;
            connectionId: string;
            createdByUserId?: string;
            extend?: any;
            failureCount: number;
            groupId: string;
            lastFailureAt?: number;
            lastSuccessAt?: number;
            secretCiphertext: string;
            status: "active" | "disabled";
            subscriptions: Array<
              | "user.created"
              | "user.updated"
              | "session.signed_in"
              | "session.signed_out"
              | "session.invalidated"
              | "session.refresh_exchanged"
              | "session.refresh_reuse_detected"
              | "account.linked"
              | "account.unlinked"
              | "password.changed"
              | "passkey.added"
              | "passkey.removed"
              | "totp.enrolled"
              | "totp.removed"
              | "email.verified"
              | "phone.verified"
              | "api_key.created"
              | "api_key.revoked"
              | "oauth.client.created"
              | "oauth.client.revoked"
              | "oauth.code.created"
              | "oauth.token.created"
              | "oauth.token.exchanged"
              | "oauth.refresh.reuse_detected"
              | "oauth.refresh.revoked"
              | "connection.created"
              | "connection.updated"
              | "connection.removed"
              | "connection.login.succeeded"
              | "connection.login.failed"
              | "connection.domain.verification_requested"
              | "connection.domain.verified"
              | "connection.policy.updated"
              | "connection.saml.set"
              | "connection.saml.refreshed"
              | "connection.oidc.set"
              | "connection.scim.set"
              | "connection.scim.read"
              | "connection.scim.user.provisioned"
              | "connection.scim.user.updated"
              | "connection.scim.user.deactivated"
              | "connection.scim.user.reactivated"
              | "connection.scim.group.provisioned"
              | "connection.scim.group.updated"
              | "connection.scim.group.deactivated"
              | "connection.scim.group.reactivated"
              | "webhook.endpoint.created"
              | "webhook.endpoint.disabled"
              | "webhook.delivery.created"
              | "webhook.delivery.attempted"
              | "webhook.delivery.succeeded"
              | "webhook.delivery.failed"
            >;
            url: string;
          }>,
          Name
        >;
        update: FunctionReference<
          "mutation",
          "internal",
          {
            id: string;
            patch: {
              extend?: any;
              failureCount?: number;
              lastFailureAt?: number;
              lastSuccessAt?: number;
              secretCiphertext?: string;
              status?: "active" | "disabled";
              subscriptions?: Array<
                | "user.created"
                | "user.updated"
                | "session.signed_in"
                | "session.signed_out"
                | "session.invalidated"
                | "session.refresh_exchanged"
                | "session.refresh_reuse_detected"
                | "account.linked"
                | "account.unlinked"
                | "password.changed"
                | "passkey.added"
                | "passkey.removed"
                | "totp.enrolled"
                | "totp.removed"
                | "email.verified"
                | "phone.verified"
                | "api_key.created"
                | "api_key.revoked"
                | "oauth.client.created"
                | "oauth.client.revoked"
                | "oauth.code.created"
                | "oauth.token.created"
                | "oauth.token.exchanged"
                | "oauth.refresh.reuse_detected"
                | "oauth.refresh.revoked"
                | "connection.created"
                | "connection.updated"
                | "connection.removed"
                | "connection.login.succeeded"
                | "connection.login.failed"
                | "connection.domain.verification_requested"
                | "connection.domain.verified"
                | "connection.policy.updated"
                | "connection.saml.set"
                | "connection.saml.refreshed"
                | "connection.oidc.set"
                | "connection.scim.set"
                | "connection.scim.read"
                | "connection.scim.user.provisioned"
                | "connection.scim.user.updated"
                | "connection.scim.user.deactivated"
                | "connection.scim.user.reactivated"
                | "connection.scim.group.provisioned"
                | "connection.scim.group.updated"
                | "connection.scim.group.deactivated"
                | "connection.scim.group.reactivated"
                | "webhook.endpoint.created"
                | "webhook.endpoint.disabled"
                | "webhook.delivery.created"
                | "webhook.delivery.attempted"
                | "webhook.delivery.succeeded"
                | "webhook.delivery.failed"
              >;
              url?: string;
            };
          },
          null,
          Name
        >;
      };
    };
  };
  event: {
    append: FunctionReference<
      "mutation",
      "internal",
      {
        event: {
          actor: {
            id?: string;
            type: "user" | "system" | "scim" | "api_key" | "oauth_client" | "webhook" | "anonymous";
          };
          category:
            | "user"
            | "session"
            | "account"
            | "password"
            | "passkey"
            | "totp"
            | "email"
            | "phone"
            | "api_key"
            | "oauth"
            | "connection"
            | "scim"
            | "webhook"
            | "security";
          data?:
            | {
                existingUserId?: string;
                profile?: Record<string, any>;
                provider?: string;
                type?: string;
              }
            | { method?: string; provider: string }
            | {
                flow?: "reset" | "change";
                reason?: string;
                refreshTokenId?: string;
                sessionId?: string;
                userId?: string;
              }
            | {
                accountId?: string;
                provider?: string;
                providerAccountId?: string;
              }
            | {
                credentialId?: string;
                keyId?: string;
                name?: string;
                passkeyId?: string;
                prefix?: string;
                totpId?: string;
              }
            | { email?: string; phone?: string; userId?: string }
            | {
                clientId?: string;
                codeId?: string;
                grantType?: string;
                name?: string;
                redirectUri?: string;
                resource?: string;
                scopes?: Array<string>;
                userId?: string;
              }
            | {
                audience?: string | Array<string>;
                connectionId?: string;
                discoveryUrl?: string;
                domain?: string;
                domains?: Array<string>;
                errorCode?: string;
                expiresAt?: number;
                issuer?: string;
                jwksUri?: string;
                metadataUrl?: string;
                protocol?: "oidc" | "saml";
                recordName?: string;
                tokenEndpointAuthMethod?: string;
                verifiedAt?: number;
                version?: number;
              }
            | {
                active?: boolean;
                externalId?: string;
                groupId?: string;
                operation?: string;
                resourceId?: string;
                resourceType?: "user" | "group";
                scimConfigId?: string;
                userId?: string;
              }
            | {
                attemptCount?: number;
                deliveryId?: string;
                endpointId?: string;
                error?: string;
                sourceEventId?: string;
                sourceEventType?:
                  | "user.created"
                  | "user.updated"
                  | "session.signed_in"
                  | "session.signed_out"
                  | "session.invalidated"
                  | "session.refresh_exchanged"
                  | "session.refresh_reuse_detected"
                  | "account.linked"
                  | "account.unlinked"
                  | "password.changed"
                  | "passkey.added"
                  | "passkey.removed"
                  | "totp.enrolled"
                  | "totp.removed"
                  | "email.verified"
                  | "phone.verified"
                  | "api_key.created"
                  | "api_key.revoked"
                  | "oauth.client.created"
                  | "oauth.client.revoked"
                  | "oauth.code.created"
                  | "oauth.token.created"
                  | "oauth.token.exchanged"
                  | "oauth.refresh.reuse_detected"
                  | "oauth.refresh.revoked"
                  | "connection.created"
                  | "connection.updated"
                  | "connection.removed"
                  | "connection.login.succeeded"
                  | "connection.login.failed"
                  | "connection.domain.verification_requested"
                  | "connection.domain.verified"
                  | "connection.policy.updated"
                  | "connection.saml.set"
                  | "connection.saml.refreshed"
                  | "connection.oidc.set"
                  | "connection.scim.set"
                  | "connection.scim.read"
                  | "connection.scim.user.provisioned"
                  | "connection.scim.user.updated"
                  | "connection.scim.user.deactivated"
                  | "connection.scim.user.reactivated"
                  | "connection.scim.group.provisioned"
                  | "connection.scim.group.updated"
                  | "connection.scim.group.deactivated"
                  | "connection.scim.group.reactivated"
                  | "webhook.endpoint.created"
                  | "webhook.endpoint.disabled"
                  | "webhook.delivery.created"
                  | "webhook.delivery.attempted"
                  | "webhook.delivery.succeeded"
                  | "webhook.delivery.failed";
                status?: number;
              };
          errorCode?: string;
          eventId: string;
          kind:
            | "user.created"
            | "user.updated"
            | "session.signed_in"
            | "session.signed_out"
            | "session.invalidated"
            | "session.refresh_exchanged"
            | "session.refresh_reuse_detected"
            | "account.linked"
            | "account.unlinked"
            | "password.changed"
            | "passkey.added"
            | "passkey.removed"
            | "totp.enrolled"
            | "totp.removed"
            | "email.verified"
            | "phone.verified"
            | "api_key.created"
            | "api_key.revoked"
            | "oauth.client.created"
            | "oauth.client.revoked"
            | "oauth.code.created"
            | "oauth.token.created"
            | "oauth.token.exchanged"
            | "oauth.refresh.reuse_detected"
            | "oauth.refresh.revoked"
            | "connection.created"
            | "connection.updated"
            | "connection.removed"
            | "connection.login.succeeded"
            | "connection.login.failed"
            | "connection.domain.verification_requested"
            | "connection.domain.verified"
            | "connection.policy.updated"
            | "connection.saml.set"
            | "connection.saml.refreshed"
            | "connection.oidc.set"
            | "connection.scim.set"
            | "connection.scim.read"
            | "connection.scim.user.provisioned"
            | "connection.scim.user.updated"
            | "connection.scim.user.deactivated"
            | "connection.scim.user.reactivated"
            | "connection.scim.group.provisioned"
            | "connection.scim.group.updated"
            | "connection.scim.group.deactivated"
            | "connection.scim.group.reactivated"
            | "webhook.endpoint.created"
            | "webhook.endpoint.disabled"
            | "webhook.delivery.created"
            | "webhook.delivery.attempted"
            | "webhook.delivery.succeeded"
            | "webhook.delivery.failed";
          occurredAt: number;
          outcome: "success" | "failure";
          request?: { ip?: string; requestId?: string; userAgent?: string };
          subject: {
            id?: string;
            type:
              | "user"
              | "session"
              | "account"
              | "passkey"
              | "totp"
              | "email"
              | "phone"
              | "api_key"
              | "oauth_client"
              | "oauth_code"
              | "group"
              | "connection"
              | "scim_identity"
              | "webhook_endpoint"
              | "webhook_delivery"
              | "system";
          };
          targets: Array<{
            id: string;
            kind:
              | "user"
              | "session"
              | "group"
              | "connection"
              | "oauth_client"
              | "api_key"
              | "global";
          }>;
        };
        idempotencyKey?: string;
        targets?: Array<{
          id: string;
          kind: "user" | "session" | "group" | "connection" | "oauth_client" | "api_key" | "global";
        }>;
      },
      {
        created: boolean;
        createdTargets: Array<{
          id: string;
          kind: "user" | "session" | "group" | "connection" | "oauth_client" | "api_key" | "global";
        }>;
        eventId: string;
        projections: Array<{
          _creationTime: number;
          _id: string;
          actorId?: string;
          actorType:
            | "user"
            | "system"
            | "scim"
            | "api_key"
            | "oauth_client"
            | "webhook"
            | "anonymous";
          category:
            | "user"
            | "session"
            | "account"
            | "password"
            | "passkey"
            | "totp"
            | "email"
            | "phone"
            | "api_key"
            | "oauth"
            | "connection"
            | "scim"
            | "webhook"
            | "security";
          data?:
            | {
                existingUserId?: string;
                profile?: Record<string, any>;
                provider?: string;
                type?: string;
              }
            | { method?: string; provider: string }
            | {
                flow?: "reset" | "change";
                reason?: string;
                refreshTokenId?: string;
                sessionId?: string;
                userId?: string;
              }
            | {
                accountId?: string;
                provider?: string;
                providerAccountId?: string;
              }
            | {
                credentialId?: string;
                keyId?: string;
                name?: string;
                passkeyId?: string;
                prefix?: string;
                totpId?: string;
              }
            | { email?: string; phone?: string; userId?: string }
            | {
                clientId?: string;
                codeId?: string;
                grantType?: string;
                name?: string;
                redirectUri?: string;
                resource?: string;
                scopes?: Array<string>;
                userId?: string;
              }
            | {
                audience?: string | Array<string>;
                connectionId?: string;
                discoveryUrl?: string;
                domain?: string;
                domains?: Array<string>;
                errorCode?: string;
                expiresAt?: number;
                issuer?: string;
                jwksUri?: string;
                metadataUrl?: string;
                protocol?: "oidc" | "saml";
                recordName?: string;
                tokenEndpointAuthMethod?: string;
                verifiedAt?: number;
                version?: number;
              }
            | {
                active?: boolean;
                externalId?: string;
                groupId?: string;
                operation?: string;
                resourceId?: string;
                resourceType?: "user" | "group";
                scimConfigId?: string;
                userId?: string;
              }
            | {
                attemptCount?: number;
                deliveryId?: string;
                endpointId?: string;
                error?: string;
                sourceEventId?: string;
                sourceEventType?:
                  | "user.created"
                  | "user.updated"
                  | "session.signed_in"
                  | "session.signed_out"
                  | "session.invalidated"
                  | "session.refresh_exchanged"
                  | "session.refresh_reuse_detected"
                  | "account.linked"
                  | "account.unlinked"
                  | "password.changed"
                  | "passkey.added"
                  | "passkey.removed"
                  | "totp.enrolled"
                  | "totp.removed"
                  | "email.verified"
                  | "phone.verified"
                  | "api_key.created"
                  | "api_key.revoked"
                  | "oauth.client.created"
                  | "oauth.client.revoked"
                  | "oauth.code.created"
                  | "oauth.token.created"
                  | "oauth.token.exchanged"
                  | "oauth.refresh.reuse_detected"
                  | "oauth.refresh.revoked"
                  | "connection.created"
                  | "connection.updated"
                  | "connection.removed"
                  | "connection.login.succeeded"
                  | "connection.login.failed"
                  | "connection.domain.verification_requested"
                  | "connection.domain.verified"
                  | "connection.policy.updated"
                  | "connection.saml.set"
                  | "connection.saml.refreshed"
                  | "connection.oidc.set"
                  | "connection.scim.set"
                  | "connection.scim.read"
                  | "connection.scim.user.provisioned"
                  | "connection.scim.user.updated"
                  | "connection.scim.user.deactivated"
                  | "connection.scim.user.reactivated"
                  | "connection.scim.group.provisioned"
                  | "connection.scim.group.updated"
                  | "connection.scim.group.deactivated"
                  | "connection.scim.group.reactivated"
                  | "webhook.endpoint.created"
                  | "webhook.endpoint.disabled"
                  | "webhook.delivery.created"
                  | "webhook.delivery.attempted"
                  | "webhook.delivery.succeeded"
                  | "webhook.delivery.failed";
                status?: number;
              };
          errorCode?: string;
          eventId: string;
          ip?: string;
          kind:
            | "user.created"
            | "user.updated"
            | "session.signed_in"
            | "session.signed_out"
            | "session.invalidated"
            | "session.refresh_exchanged"
            | "session.refresh_reuse_detected"
            | "account.linked"
            | "account.unlinked"
            | "password.changed"
            | "passkey.added"
            | "passkey.removed"
            | "totp.enrolled"
            | "totp.removed"
            | "email.verified"
            | "phone.verified"
            | "api_key.created"
            | "api_key.revoked"
            | "oauth.client.created"
            | "oauth.client.revoked"
            | "oauth.code.created"
            | "oauth.token.created"
            | "oauth.token.exchanged"
            | "oauth.refresh.reuse_detected"
            | "oauth.refresh.revoked"
            | "connection.created"
            | "connection.updated"
            | "connection.removed"
            | "connection.login.succeeded"
            | "connection.login.failed"
            | "connection.domain.verification_requested"
            | "connection.domain.verified"
            | "connection.policy.updated"
            | "connection.saml.set"
            | "connection.saml.refreshed"
            | "connection.oidc.set"
            | "connection.scim.set"
            | "connection.scim.read"
            | "connection.scim.user.provisioned"
            | "connection.scim.user.updated"
            | "connection.scim.user.deactivated"
            | "connection.scim.user.reactivated"
            | "connection.scim.group.provisioned"
            | "connection.scim.group.updated"
            | "connection.scim.group.deactivated"
            | "connection.scim.group.reactivated"
            | "webhook.endpoint.created"
            | "webhook.endpoint.disabled"
            | "webhook.delivery.created"
            | "webhook.delivery.attempted"
            | "webhook.delivery.succeeded"
            | "webhook.delivery.failed";
          occurredAt: number;
          outcome: "success" | "failure";
          requestId?: string;
          subjectId?: string;
          subjectType:
            | "user"
            | "session"
            | "account"
            | "passkey"
            | "totp"
            | "email"
            | "phone"
            | "api_key"
            | "oauth_client"
            | "oauth_code"
            | "group"
            | "connection"
            | "scim_identity"
            | "webhook_endpoint"
            | "webhook_delivery"
            | "system";
          targetId: string;
          targetKind:
            | "user"
            | "session"
            | "group"
            | "connection"
            | "oauth_client"
            | "api_key"
            | "global";
        }>;
      },
      Name
    >;
    get: FunctionReference<
      "query",
      "internal",
      { id: string },
      {
        _creationTime: number;
        _id: string;
        actorId?: string;
        actorType:
          | "user"
          | "system"
          | "scim"
          | "api_key"
          | "oauth_client"
          | "webhook"
          | "anonymous";
        category:
          | "user"
          | "session"
          | "account"
          | "password"
          | "passkey"
          | "totp"
          | "email"
          | "phone"
          | "api_key"
          | "oauth"
          | "connection"
          | "scim"
          | "webhook"
          | "security";
        data?:
          | {
              existingUserId?: string;
              profile?: Record<string, any>;
              provider?: string;
              type?: string;
            }
          | { method?: string; provider: string }
          | {
              flow?: "reset" | "change";
              reason?: string;
              refreshTokenId?: string;
              sessionId?: string;
              userId?: string;
            }
          | {
              accountId?: string;
              provider?: string;
              providerAccountId?: string;
            }
          | {
              credentialId?: string;
              keyId?: string;
              name?: string;
              passkeyId?: string;
              prefix?: string;
              totpId?: string;
            }
          | { email?: string; phone?: string; userId?: string }
          | {
              clientId?: string;
              codeId?: string;
              grantType?: string;
              name?: string;
              redirectUri?: string;
              resource?: string;
              scopes?: Array<string>;
              userId?: string;
            }
          | {
              audience?: string | Array<string>;
              connectionId?: string;
              discoveryUrl?: string;
              domain?: string;
              domains?: Array<string>;
              errorCode?: string;
              expiresAt?: number;
              issuer?: string;
              jwksUri?: string;
              metadataUrl?: string;
              protocol?: "oidc" | "saml";
              recordName?: string;
              tokenEndpointAuthMethod?: string;
              verifiedAt?: number;
              version?: number;
            }
          | {
              active?: boolean;
              externalId?: string;
              groupId?: string;
              operation?: string;
              resourceId?: string;
              resourceType?: "user" | "group";
              scimConfigId?: string;
              userId?: string;
            }
          | {
              attemptCount?: number;
              deliveryId?: string;
              endpointId?: string;
              error?: string;
              sourceEventId?: string;
              sourceEventType?:
                | "user.created"
                | "user.updated"
                | "session.signed_in"
                | "session.signed_out"
                | "session.invalidated"
                | "session.refresh_exchanged"
                | "session.refresh_reuse_detected"
                | "account.linked"
                | "account.unlinked"
                | "password.changed"
                | "passkey.added"
                | "passkey.removed"
                | "totp.enrolled"
                | "totp.removed"
                | "email.verified"
                | "phone.verified"
                | "api_key.created"
                | "api_key.revoked"
                | "oauth.client.created"
                | "oauth.client.revoked"
                | "oauth.code.created"
                | "oauth.token.created"
                | "oauth.token.exchanged"
                | "oauth.refresh.reuse_detected"
                | "oauth.refresh.revoked"
                | "connection.created"
                | "connection.updated"
                | "connection.removed"
                | "connection.login.succeeded"
                | "connection.login.failed"
                | "connection.domain.verification_requested"
                | "connection.domain.verified"
                | "connection.policy.updated"
                | "connection.saml.set"
                | "connection.saml.refreshed"
                | "connection.oidc.set"
                | "connection.scim.set"
                | "connection.scim.read"
                | "connection.scim.user.provisioned"
                | "connection.scim.user.updated"
                | "connection.scim.user.deactivated"
                | "connection.scim.user.reactivated"
                | "connection.scim.group.provisioned"
                | "connection.scim.group.updated"
                | "connection.scim.group.deactivated"
                | "connection.scim.group.reactivated"
                | "webhook.endpoint.created"
                | "webhook.endpoint.disabled"
                | "webhook.delivery.created"
                | "webhook.delivery.attempted"
                | "webhook.delivery.succeeded"
                | "webhook.delivery.failed";
              status?: number;
            };
        errorCode?: string;
        eventId: string;
        ip?: string;
        kind:
          | "user.created"
          | "user.updated"
          | "session.signed_in"
          | "session.signed_out"
          | "session.invalidated"
          | "session.refresh_exchanged"
          | "session.refresh_reuse_detected"
          | "account.linked"
          | "account.unlinked"
          | "password.changed"
          | "passkey.added"
          | "passkey.removed"
          | "totp.enrolled"
          | "totp.removed"
          | "email.verified"
          | "phone.verified"
          | "api_key.created"
          | "api_key.revoked"
          | "oauth.client.created"
          | "oauth.client.revoked"
          | "oauth.code.created"
          | "oauth.token.created"
          | "oauth.token.exchanged"
          | "oauth.refresh.reuse_detected"
          | "oauth.refresh.revoked"
          | "connection.created"
          | "connection.updated"
          | "connection.removed"
          | "connection.login.succeeded"
          | "connection.login.failed"
          | "connection.domain.verification_requested"
          | "connection.domain.verified"
          | "connection.policy.updated"
          | "connection.saml.set"
          | "connection.saml.refreshed"
          | "connection.oidc.set"
          | "connection.scim.set"
          | "connection.scim.read"
          | "connection.scim.user.provisioned"
          | "connection.scim.user.updated"
          | "connection.scim.user.deactivated"
          | "connection.scim.user.reactivated"
          | "connection.scim.group.provisioned"
          | "connection.scim.group.updated"
          | "connection.scim.group.deactivated"
          | "connection.scim.group.reactivated"
          | "webhook.endpoint.created"
          | "webhook.endpoint.disabled"
          | "webhook.delivery.created"
          | "webhook.delivery.attempted"
          | "webhook.delivery.succeeded"
          | "webhook.delivery.failed";
        occurredAt: number;
        outcome: "success" | "failure";
        requestId?: string;
        subjectId?: string;
        subjectType:
          | "user"
          | "session"
          | "account"
          | "passkey"
          | "totp"
          | "email"
          | "phone"
          | "api_key"
          | "oauth_client"
          | "oauth_code"
          | "group"
          | "connection"
          | "scim_identity"
          | "webhook_endpoint"
          | "webhook_delivery"
          | "system";
        targetId: string;
        targetKind:
          | "user"
          | "session"
          | "group"
          | "connection"
          | "oauth_client"
          | "api_key"
          | "global";
      } | null,
      Name
    >;
    list: FunctionReference<
      "query",
      "internal",
      {
        order?: "asc" | "desc";
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        where: {
          actor?: {
            id?: string;
            type: "user" | "system" | "scim" | "api_key" | "oauth_client" | "webhook" | "anonymous";
          };
          category?:
            | "user"
            | "session"
            | "account"
            | "password"
            | "passkey"
            | "totp"
            | "email"
            | "phone"
            | "api_key"
            | "oauth"
            | "connection"
            | "scim"
            | "webhook"
            | "security";
          kind?:
            | "user.created"
            | "user.updated"
            | "session.signed_in"
            | "session.signed_out"
            | "session.invalidated"
            | "session.refresh_exchanged"
            | "session.refresh_reuse_detected"
            | "account.linked"
            | "account.unlinked"
            | "password.changed"
            | "passkey.added"
            | "passkey.removed"
            | "totp.enrolled"
            | "totp.removed"
            | "email.verified"
            | "phone.verified"
            | "api_key.created"
            | "api_key.revoked"
            | "oauth.client.created"
            | "oauth.client.revoked"
            | "oauth.code.created"
            | "oauth.token.created"
            | "oauth.token.exchanged"
            | "oauth.refresh.reuse_detected"
            | "oauth.refresh.revoked"
            | "connection.created"
            | "connection.updated"
            | "connection.removed"
            | "connection.login.succeeded"
            | "connection.login.failed"
            | "connection.domain.verification_requested"
            | "connection.domain.verified"
            | "connection.policy.updated"
            | "connection.saml.set"
            | "connection.saml.refreshed"
            | "connection.oidc.set"
            | "connection.scim.set"
            | "connection.scim.read"
            | "connection.scim.user.provisioned"
            | "connection.scim.user.updated"
            | "connection.scim.user.deactivated"
            | "connection.scim.user.reactivated"
            | "connection.scim.group.provisioned"
            | "connection.scim.group.updated"
            | "connection.scim.group.deactivated"
            | "connection.scim.group.reactivated"
            | "webhook.endpoint.created"
            | "webhook.endpoint.disabled"
            | "webhook.delivery.created"
            | "webhook.delivery.attempted"
            | "webhook.delivery.succeeded"
            | "webhook.delivery.failed";
          occurredAtGt?: number;
          occurredAtGte?: number;
          occurredAtLt?: number;
          occurredAtLte?: number;
          outcome?: "success" | "failure";
          requestId?: string;
          subject?: {
            id?: string;
            type:
              | "user"
              | "session"
              | "account"
              | "passkey"
              | "totp"
              | "email"
              | "phone"
              | "api_key"
              | "oauth_client"
              | "oauth_code"
              | "group"
              | "connection"
              | "scim_identity"
              | "webhook_endpoint"
              | "webhook_delivery"
              | "system";
          };
          target?: {
            id: string;
            kind:
              | "user"
              | "session"
              | "group"
              | "connection"
              | "oauth_client"
              | "api_key"
              | "global";
          };
        };
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: string;
          actorId?: string;
          actorType:
            | "user"
            | "system"
            | "scim"
            | "api_key"
            | "oauth_client"
            | "webhook"
            | "anonymous";
          category:
            | "user"
            | "session"
            | "account"
            | "password"
            | "passkey"
            | "totp"
            | "email"
            | "phone"
            | "api_key"
            | "oauth"
            | "connection"
            | "scim"
            | "webhook"
            | "security";
          data?:
            | {
                existingUserId?: string;
                profile?: Record<string, any>;
                provider?: string;
                type?: string;
              }
            | { method?: string; provider: string }
            | {
                flow?: "reset" | "change";
                reason?: string;
                refreshTokenId?: string;
                sessionId?: string;
                userId?: string;
              }
            | {
                accountId?: string;
                provider?: string;
                providerAccountId?: string;
              }
            | {
                credentialId?: string;
                keyId?: string;
                name?: string;
                passkeyId?: string;
                prefix?: string;
                totpId?: string;
              }
            | { email?: string; phone?: string; userId?: string }
            | {
                clientId?: string;
                codeId?: string;
                grantType?: string;
                name?: string;
                redirectUri?: string;
                resource?: string;
                scopes?: Array<string>;
                userId?: string;
              }
            | {
                audience?: string | Array<string>;
                connectionId?: string;
                discoveryUrl?: string;
                domain?: string;
                domains?: Array<string>;
                errorCode?: string;
                expiresAt?: number;
                issuer?: string;
                jwksUri?: string;
                metadataUrl?: string;
                protocol?: "oidc" | "saml";
                recordName?: string;
                tokenEndpointAuthMethod?: string;
                verifiedAt?: number;
                version?: number;
              }
            | {
                active?: boolean;
                externalId?: string;
                groupId?: string;
                operation?: string;
                resourceId?: string;
                resourceType?: "user" | "group";
                scimConfigId?: string;
                userId?: string;
              }
            | {
                attemptCount?: number;
                deliveryId?: string;
                endpointId?: string;
                error?: string;
                sourceEventId?: string;
                sourceEventType?:
                  | "user.created"
                  | "user.updated"
                  | "session.signed_in"
                  | "session.signed_out"
                  | "session.invalidated"
                  | "session.refresh_exchanged"
                  | "session.refresh_reuse_detected"
                  | "account.linked"
                  | "account.unlinked"
                  | "password.changed"
                  | "passkey.added"
                  | "passkey.removed"
                  | "totp.enrolled"
                  | "totp.removed"
                  | "email.verified"
                  | "phone.verified"
                  | "api_key.created"
                  | "api_key.revoked"
                  | "oauth.client.created"
                  | "oauth.client.revoked"
                  | "oauth.code.created"
                  | "oauth.token.created"
                  | "oauth.token.exchanged"
                  | "oauth.refresh.reuse_detected"
                  | "oauth.refresh.revoked"
                  | "connection.created"
                  | "connection.updated"
                  | "connection.removed"
                  | "connection.login.succeeded"
                  | "connection.login.failed"
                  | "connection.domain.verification_requested"
                  | "connection.domain.verified"
                  | "connection.policy.updated"
                  | "connection.saml.set"
                  | "connection.saml.refreshed"
                  | "connection.oidc.set"
                  | "connection.scim.set"
                  | "connection.scim.read"
                  | "connection.scim.user.provisioned"
                  | "connection.scim.user.updated"
                  | "connection.scim.user.deactivated"
                  | "connection.scim.user.reactivated"
                  | "connection.scim.group.provisioned"
                  | "connection.scim.group.updated"
                  | "connection.scim.group.deactivated"
                  | "connection.scim.group.reactivated"
                  | "webhook.endpoint.created"
                  | "webhook.endpoint.disabled"
                  | "webhook.delivery.created"
                  | "webhook.delivery.attempted"
                  | "webhook.delivery.succeeded"
                  | "webhook.delivery.failed";
                status?: number;
              };
          errorCode?: string;
          eventId: string;
          ip?: string;
          kind:
            | "user.created"
            | "user.updated"
            | "session.signed_in"
            | "session.signed_out"
            | "session.invalidated"
            | "session.refresh_exchanged"
            | "session.refresh_reuse_detected"
            | "account.linked"
            | "account.unlinked"
            | "password.changed"
            | "passkey.added"
            | "passkey.removed"
            | "totp.enrolled"
            | "totp.removed"
            | "email.verified"
            | "phone.verified"
            | "api_key.created"
            | "api_key.revoked"
            | "oauth.client.created"
            | "oauth.client.revoked"
            | "oauth.code.created"
            | "oauth.token.created"
            | "oauth.token.exchanged"
            | "oauth.refresh.reuse_detected"
            | "oauth.refresh.revoked"
            | "connection.created"
            | "connection.updated"
            | "connection.removed"
            | "connection.login.succeeded"
            | "connection.login.failed"
            | "connection.domain.verification_requested"
            | "connection.domain.verified"
            | "connection.policy.updated"
            | "connection.saml.set"
            | "connection.saml.refreshed"
            | "connection.oidc.set"
            | "connection.scim.set"
            | "connection.scim.read"
            | "connection.scim.user.provisioned"
            | "connection.scim.user.updated"
            | "connection.scim.user.deactivated"
            | "connection.scim.user.reactivated"
            | "connection.scim.group.provisioned"
            | "connection.scim.group.updated"
            | "connection.scim.group.deactivated"
            | "connection.scim.group.reactivated"
            | "webhook.endpoint.created"
            | "webhook.endpoint.disabled"
            | "webhook.delivery.created"
            | "webhook.delivery.attempted"
            | "webhook.delivery.succeeded"
            | "webhook.delivery.failed";
          occurredAt: number;
          outcome: "success" | "failure";
          requestId?: string;
          subjectId?: string;
          subjectType:
            | "user"
            | "session"
            | "account"
            | "passkey"
            | "totp"
            | "email"
            | "phone"
            | "api_key"
            | "oauth_client"
            | "oauth_code"
            | "group"
            | "connection"
            | "scim_identity"
            | "webhook_endpoint"
            | "webhook_delivery"
            | "system";
          targetId: string;
          targetKind:
            | "user"
            | "session"
            | "group"
            | "connection"
            | "oauth_client"
            | "api_key"
            | "global";
        }>;
        pageStatus?: "SplitRecommended" | "SplitRequired" | null;
        splitCursor?: string | null;
      },
      Name
    >;
  };
  factor: {
    device: {
      accept: FunctionReference<
        "mutation",
        "internal",
        { deviceCodeHash: string; now: number },
        { sessionId: string; userId: string } | null,
        Name
      >;
      authorize: FunctionReference<
        "mutation",
        "internal",
        { id: string; sessionId: string; userId: string },
        { transitioned: boolean },
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          deviceCodeHash: string;
          expiresAt: number;
          interval: number;
          status: "pending" | "authorized" | "denied";
          userCode: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { deviceCodeHash?: string; id?: string; userCode?: string },
        {
          _creationTime: number;
          _id: string;
          deviceCodeHash: string;
          expiresAt: number;
          interval: number;
          lastPolledAt?: number;
          sessionId?: string;
          status: "pending" | "authorized" | "denied";
          userCode: string;
          userId?: string;
        } | null,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: {
            lastPolledAt?: number;
            sessionId?: string;
            status?: "pending" | "authorized" | "denied";
            userId?: string;
          };
        },
        null,
        Name
      >;
    };
    passkey: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          algorithm: number;
          backedUp: boolean;
          counter: number;
          createdAt: number;
          credentialId: string;
          deviceType: string;
          name?: string;
          publicKey: ArrayBuffer;
          transports?: Array<string>;
          userId: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { credentialId?: string; id?: string },
        {
          _creationTime: number;
          _id: string;
          algorithm: number;
          backedUp: boolean;
          counter: number;
          createdAt: number;
          credentialId: string;
          deviceType: string;
          lastUsedAt?: number;
          name?: string;
          publicKey: ArrayBuffer;
          transports?: Array<string>;
          userId: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          _creationTime: number;
          _id: string;
          algorithm: number;
          backedUp: boolean;
          counter: number;
          createdAt: number;
          credentialId: string;
          deviceType: string;
          lastUsedAt?: number;
          name?: string;
          publicKey: ArrayBuffer;
          transports?: Array<string>;
          userId: string;
        }>,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: {
            backedUp?: boolean;
            counter?: number;
            lastUsedAt?: number;
            name?: string;
            transports?: Array<string>;
          };
        },
        null,
        Name
      >;
    };
    totp: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          createdAt: number;
          digits: number;
          name?: string;
          period: number;
          secret: ArrayBuffer;
          userId: string;
          verified: boolean;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { id?: string; verifiedForUserId?: string },
        {
          _creationTime: number;
          _id: string;
          createdAt: number;
          digits: number;
          lastUsedAt?: number;
          name?: string;
          period: number;
          secret: ArrayBuffer;
          userId: string;
          verified: boolean;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          _creationTime: number;
          _id: string;
          createdAt: number;
          digits: number;
          lastUsedAt?: number;
          name?: string;
          period: number;
          secret: ArrayBuffer;
          userId: string;
          verified: boolean;
        }>,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: { lastUsedAt?: number; name?: string; verified?: boolean };
        },
        null,
        Name
      >;
    };
  };
  group: {
    ancestors: FunctionReference<
      "query",
      "internal",
      { id: string; includeSelf?: boolean; maxDepth?: number },
      {
        ancestors: Array<{
          _creationTime: number;
          _id: string;
          extend?: any;
          isRoot?: boolean;
          name: string;
          parentGroupId?: string;
          policy?: {
            extend?: any;
            identity: {
              accountLinking: {
                oidc: "verifiedEmail" | "none" | "sameConnection";
                saml: "verifiedEmail" | "none" | "sameConnection";
              };
            };
            provisioning: {
              deprovision: { mode: "soft" | "hard" };
              groups: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "sync";
                source: "protocol";
              };
              jit: {
                defaultRole?: string;
                defaultRoleIds?: Array<string>;
                mode: "off" | "createUser" | "createUserAndMembership";
              };
              roles: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "map";
                source: "protocol";
              };
              scimReuse: { user: "externalId" | "none" };
              user: {
                authority: "app" | "connection" | "scim";
                createOnSignIn: boolean;
                updateProfileFromScim: "never" | "missing" | "always";
                updateProfileOnLogin: "never" | "missing" | "always";
              };
            };
            version: 1;
          };
          rootGroupId?: string;
          slug?: string;
          type?: string;
        }>;
        cycleDetected: boolean;
        maxDepthReached: boolean;
      },
      Name
    >;
    create: FunctionReference<
      "mutation",
      "internal",
      {
        extend?: any;
        name: string;
        parentGroupId?: string;
        slug?: string;
        type?: string;
      },
      string,
      Name
    >;
    get: FunctionReference<
      "query",
      "internal",
      { id?: string; ids?: Array<string> },
      | {
          _creationTime: number;
          _id: string;
          extend?: any;
          isRoot?: boolean;
          name: string;
          parentGroupId?: string;
          policy?: {
            extend?: any;
            identity: {
              accountLinking: {
                oidc: "verifiedEmail" | "none" | "sameConnection";
                saml: "verifiedEmail" | "none" | "sameConnection";
              };
            };
            provisioning: {
              deprovision: { mode: "soft" | "hard" };
              groups: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "sync";
                source: "protocol";
              };
              jit: {
                defaultRole?: string;
                defaultRoleIds?: Array<string>;
                mode: "off" | "createUser" | "createUserAndMembership";
              };
              roles: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "map";
                source: "protocol";
              };
              scimReuse: { user: "externalId" | "none" };
              user: {
                authority: "app" | "connection" | "scim";
                createOnSignIn: boolean;
                updateProfileFromScim: "never" | "missing" | "always";
                updateProfileOnLogin: "never" | "missing" | "always";
              };
            };
            version: 1;
          };
          rootGroupId?: string;
          slug?: string;
          type?: string;
        }
      | null
      | Array<{
          _creationTime: number;
          _id: string;
          extend?: any;
          isRoot?: boolean;
          name: string;
          parentGroupId?: string;
          policy?: {
            extend?: any;
            identity: {
              accountLinking: {
                oidc: "verifiedEmail" | "none" | "sameConnection";
                saml: "verifiedEmail" | "none" | "sameConnection";
              };
            };
            provisioning: {
              deprovision: { mode: "soft" | "hard" };
              groups: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "sync";
                source: "protocol";
              };
              jit: {
                defaultRole?: string;
                defaultRoleIds?: Array<string>;
                mode: "off" | "createUser" | "createUserAndMembership";
              };
              roles: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "map";
                source: "protocol";
              };
              scimReuse: { user: "externalId" | "none" };
              user: {
                authority: "app" | "connection" | "scim";
                createOnSignIn: boolean;
                updateProfileFromScim: "never" | "missing" | "always";
                updateProfileOnLogin: "never" | "missing" | "always";
              };
            };
            version: 1;
          };
          rootGroupId?: string;
          slug?: string;
          type?: string;
        } | null>,
      Name
    >;
    invite: {
      accept: FunctionReference<
        "mutation",
        "internal",
        { acceptedByUserId?: string; id?: string; tokenHash?: string },
        null | {
          groupId: string | null;
          inviteId: string;
          inviteStatus: "accepted" | "already_accepted";
          memberId?: string;
          membershipStatus: "joined" | "already_joined" | "not_applicable";
        },
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          email?: string;
          expiresTime?: number;
          extend?: any;
          groupId?: string;
          invitedByUserId?: string;
          roleIds?: Array<string>;
          status: "pending" | "accepted" | "revoked" | "expired";
          tokenHash: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { id?: string; tokenHash?: string },
        {
          _creationTime: number;
          _id: string;
          acceptedByUserId?: string;
          acceptedTime?: number;
          email?: string;
          expiresTime?: number;
          extend?: any;
          groupId?: string;
          invitedByUserId?: string;
          role?: string;
          roleIds?: Array<string>;
          status: "pending" | "accepted" | "revoked" | "expired";
          tokenHash: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          order?: "asc" | "desc";
          orderBy?: "_creationTime" | "status" | "email" | "expiresTime" | "acceptedTime";
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          where?: {
            acceptedByUserId?: string;
            email?: string;
            groupId?: string;
            invitedByUserId?: string;
            status?: "pending" | "accepted" | "revoked" | "expired";
            tokenHash?: string;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            acceptedByUserId?: string;
            acceptedTime?: number;
            email?: string;
            expiresTime?: number;
            extend?: any;
            groupId?: string;
            invitedByUserId?: string;
            role?: string;
            roleIds?: Array<string>;
            status: "pending" | "accepted" | "revoked" | "expired";
            tokenHash: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      revoke: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
    };
    list: FunctionReference<
      "query",
      "internal",
      {
        order?: "asc" | "desc";
        orderBy?: "_creationTime" | "name" | "slug" | "type";
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        where?: {
          isRoot?: boolean;
          name?: string;
          parentGroupId?: string;
          slug?: string;
          type?: string;
        };
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: string;
          extend?: any;
          isRoot?: boolean;
          name: string;
          parentGroupId?: string;
          policy?: {
            extend?: any;
            identity: {
              accountLinking: {
                oidc: "verifiedEmail" | "none" | "sameConnection";
                saml: "verifiedEmail" | "none" | "sameConnection";
              };
            };
            provisioning: {
              deprovision: { mode: "soft" | "hard" };
              groups: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "sync";
                source: "protocol";
              };
              jit: {
                defaultRole?: string;
                defaultRoleIds?: Array<string>;
                mode: "off" | "createUser" | "createUserAndMembership";
              };
              roles: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "map";
                source: "protocol";
              };
              scimReuse: { user: "externalId" | "none" };
              user: {
                authority: "app" | "connection" | "scim";
                createOnSignIn: boolean;
                updateProfileFromScim: "never" | "missing" | "always";
                updateProfileOnLogin: "never" | "missing" | "always";
              };
            };
            version: 1;
          };
          rootGroupId?: string;
          slug?: string;
          type?: string;
        }>;
        pageStatus?: "SplitRecommended" | "SplitRequired" | null;
        splitCursor?: string | null;
      },
      Name
    >;
    member: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          extend?: any;
          groupId: string;
          roleIds?: Array<string>;
          status?: string;
          userId: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        {
          groupId?: string;
          groupIds?: Array<string>;
          id?: string;
          userId?: string;
        },
        | {
            _creationTime: number;
            _id: string;
            extend?: any;
            groupId: string;
            role?: string;
            roleIds?: Array<string>;
            status?: string;
            userId: string;
          }
        | null
        | Array<{
            _creationTime: number;
            _id: string;
            extend?: any;
            groupId: string;
            role?: string;
            roleIds?: Array<string>;
            status?: string;
            userId: string;
          } | null>,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          order?: "asc" | "desc";
          orderBy?: "_creationTime" | "status";
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          where?: { groupId?: string; status?: string; userId?: string };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            extend?: any;
            groupId: string;
            role?: string;
            roleIds?: Array<string>;
            status?: string;
            userId: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      resolve: FunctionReference<
        "query",
        "internal",
        {
          ancestry?: boolean;
          groupId: string;
          maxDepth?: number;
          userId: string;
        },
        {
          depth: number | null;
          isDirect: boolean;
          isInherited: boolean;
          matchedGroupId: string | null;
          membership: {
            _creationTime: number;
            _id: string;
            extend?: any;
            groupId: string;
            role?: string;
            roleIds?: Array<string>;
            status?: string;
            userId: string;
          } | null;
          traversedGroupIds?: Array<string>;
        },
        Name
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: {
            extend?: any;
            role?: string;
            roleIds?: Array<string>;
            status?: string;
          };
        },
        null,
        Name
      >;
    };
    remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
    update: FunctionReference<
      "mutation",
      "internal",
      {
        id: string;
        patch: {
          extend?: any;
          isRoot?: boolean;
          name?: string;
          parentGroupId?: string;
          policy?: {
            extend?: any;
            identity: {
              accountLinking: {
                oidc: "verifiedEmail" | "none" | "sameConnection";
                saml: "verifiedEmail" | "none" | "sameConnection";
              };
            };
            provisioning: {
              deprovision: { mode: "soft" | "hard" };
              groups: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "sync";
                source: "protocol";
              };
              jit: {
                defaultRole?: string;
                defaultRoleIds?: Array<string>;
                mode: "off" | "createUser" | "createUserAndMembership";
              };
              roles: {
                mapping?: Record<string, Array<string>>;
                mode: "ignore" | "map";
                source: "protocol";
              };
              scimReuse: { user: "externalId" | "none" };
              user: {
                authority: "app" | "connection" | "scim";
                createOnSignIn: boolean;
                updateProfileFromScim: "never" | "missing" | "always";
                updateProfileOnLogin: "never" | "missing" | "always";
              };
            };
            version: 1;
          };
          rootGroupId?: string;
          slug?: string;
          type?: string;
        };
      },
      null,
      Name
    >;
  };
  limits: {
    signInCheck: FunctionReference<
      "query",
      "internal",
      { identifier: string; maxAttemptsPerHour: number },
      { ok: boolean; retryAfter?: number },
      Name
    >;
    signInRecord: FunctionReference<
      "mutation",
      "internal",
      { identifier: string; maxAttemptsPerHour: number },
      { ok: boolean; retryAfter?: number },
      Name
    >;
    signInReset: FunctionReference<"mutation", "internal", { identifier: string }, null, Name>;
  };
  oauth: {
    client: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          clientSecretHash?: string;
          createdBy?: string;
          extend?: any;
          grantTypes: Array<string>;
          name: string;
          redirectUris: Array<string>;
          registrationAccessTokenHash?: string;
          scopes: Array<string>;
          tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { clientId?: string; id?: string },
        {
          _creationTime: number;
          _id: string;
          clientId: string;
          clientSecretHash?: string;
          createdBy?: string;
          extend?: any;
          grantTypes: Array<string>;
          name: string;
          redirectUris: Array<string>;
          registrationAccessTokenHash?: string;
          revoked: boolean;
          scopes: Array<string>;
          tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          where?: { createdBy?: string; includeRevoked?: boolean };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            clientId: string;
            clientSecretHash?: string;
            createdBy?: string;
            extend?: any;
            grantTypes: Array<string>;
            name: string;
            redirectUris: Array<string>;
            registrationAccessTokenHash?: string;
            revoked: boolean;
            scopes: Array<string>;
            tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      revoke: FunctionReference<"mutation", "internal", { clientId: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          patch: {
            grantTypes?: Array<string>;
            name?: string;
            redirectUris?: Array<string>;
            scopes?: Array<string>;
            tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
          };
        },
        null,
        Name
      >;
    };
    code: {
      accept: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          codeChallenge: string;
          codeHash: string;
          redirectUri: string;
          refresh?: { expiresAt: number; tokenHash: string };
        },
        {
          _creationTime: number;
          _id: string;
          clientId: string;
          codeChallenge: string;
          codeHash: string;
          expiresAt: number;
          redirectUri: string;
          resource?: string;
          scopes: Array<string>;
          usedAt?: number;
          userId: string;
        } | null,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          codeChallenge: string;
          codeHash: string;
          expiresAt: number;
          redirectUri: string;
          resource?: string;
          scopes: Array<string>;
          userId: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { codeHash: string },
        {
          _creationTime: number;
          _id: string;
          clientId: string;
          codeChallenge: string;
          codeHash: string;
          expiresAt: number;
          redirectUri: string;
          resource?: string;
          scopes: Array<string>;
          usedAt?: number;
          userId: string;
        } | null,
        Name
      >;
    };
    refresh: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          expiresAt: number;
          resource?: string;
          scopes: Array<string>;
          tokenHash: string;
          userId: string;
        },
        string,
        Name
      >;
      exchange: FunctionReference<
        "mutation",
        "internal",
        {
          clientId: string;
          newExpiresAt: number;
          newTokenHash: string;
          now: number;
          requestedScopes?: Array<string>;
          reuseWindowMs: number;
          tokenHash: string;
        },
        | {
            resource?: string;
            scopes: Array<string>;
            status: "rotated";
            userId: string;
          }
        | { clientId: string; status: "reuse_detected"; userId: string }
        | { status: "scope_exceeded" }
        | { status: "invalid" },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { tokenHash: string },
        {
          _creationTime: number;
          _id: string;
          expiresAt: number;
          firstUsedTime?: number;
          grantId?: string;
          parentTokenId?: string;
          tokenHash: string;
        } | null,
        Name
      >;
      revoke: FunctionReference<
        "mutation",
        "internal",
        { tokenHash: string },
        { clientId: string; userId: string } | null,
        Name
      >;
    };
  };
  session: {
    create: FunctionReference<
      "mutation",
      "internal",
      {
        refreshTokenExpirationTime?: number;
        replaceSessionId?: string;
        sessionExpirationTime: number;
        sessionId?: string;
        userId: string;
      },
      {
        refreshTokenId?: string;
        replacedSessionId?: string;
        sessionId: string;
        userId: string;
      },
      Name
    >;
    get: FunctionReference<
      "query",
      "internal",
      { id: string },
      {
        _creationTime: number;
        _id: string;
        expirationTime: number;
        userId: string;
      } | null,
      Name
    >;
    list: FunctionReference<
      "query",
      "internal",
      { userId: string },
      Array<{
        _creationTime: number;
        _id: string;
        expirationTime: number;
        userId: string;
      }>,
      Name
    >;
    remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
    revokeForUser: FunctionReference<
      "mutation",
      "internal",
      { userId: string },
      { revoked: number },
      Name
    >;
  };
  token: {
    pkce: {
      create: FunctionReference<
        "mutation",
        "internal",
        { expirationTime?: number; sessionId?: string; signature?: string },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { id?: string; signature?: string },
        {
          _creationTime: number;
          _id: string;
          expirationTime?: number;
          sessionId?: string;
          signature?: string;
        } | null,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: {
            expirationTime?: number;
            sessionId?: string;
            signature?: string;
          };
        },
        null,
        Name
      >;
    };
    refresh: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          expirationTime: number;
          parentRefreshTokenId?: string;
          sessionId: string;
        },
        string,
        Name
      >;
      exchange: FunctionReference<
        "mutation",
        "internal",
        {
          now: number;
          refreshTokenExpirationTime: number;
          refreshTokenId: string;
          reuseWindowMs: number;
          sessionId: string;
        },
        | {
            refreshTokenId: string;
            sessionId: string;
            status: "rotated";
            userId: string;
          }
        | { refreshTokenId: string; status: "reuse_detected"; userId: string }
        | { status: "invalid" },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { activeForSession?: string; id?: string },
        {
          _creationTime: number;
          _id: string;
          expirationTime: number;
          firstUsedTime?: number;
          parentRefreshTokenId?: string;
          sessionId: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { parentRefreshTokenId?: string; sessionId: string },
        Array<{
          _creationTime: number;
          _id: string;
          expirationTime: number;
          firstUsedTime?: number;
          parentRefreshTokenId?: string;
          sessionId: string;
        }>,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { sessionId: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: { expirationTime?: number; firstUsedTime?: number };
        },
        null,
        Name
      >;
    };
    verification: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: string;
          code: string;
          emailVerified?: string;
          expirationTime: number;
          phoneVerified?: string;
          provider: string;
          verifier?: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { accountId?: string; code?: string },
        {
          _creationTime: number;
          _id: string;
          accountId: string;
          code: string;
          emailVerified?: string;
          expirationTime: number;
          phoneVerified?: string;
          provider: string;
          verifier?: string;
        } | null,
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
    };
  };
  user: {
    create: FunctionReference<
      "mutation",
      "internal",
      {
        data: {
          email?: string;
          emailVerificationTime?: number;
          extend?: any;
          hasTotp?: boolean;
          image?: string;
          isAnonymous?: boolean;
          lastActiveGroup?: string;
          name?: string;
          phone?: string;
          phoneVerificationTime?: number;
        };
      },
      string,
      Name
    >;
    email: {
      list: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          _creationTime: number;
          _id: string;
          accountId?: string;
          connectionId?: string;
          email: string;
          isPrimary: boolean;
          provider?: string;
          source: "password" | "oauth" | "oidc" | "saml" | "scim";
          userId: string;
          verificationTime?: number;
        }>,
        Name
      >;
      promote: FunctionReference<
        "mutation",
        "internal",
        { email: string; userId: string },
        null,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { email: string; userId: string },
        null,
        Name
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        {
          accountId?: string;
          connectionId?: string;
          email: string;
          isPrimary?: boolean;
          provider?: string;
          source: "password" | "oauth" | "oidc" | "saml" | "scim";
          userId: string;
          verified?: boolean;
        },
        string,
        Name
      >;
    };
    get: FunctionReference<
      "query",
      "internal",
      {
        id?: string;
        ids?: Array<string>;
        verifiedEmail?: string;
        verifiedPhone?: string;
      },
      | {
          _creationTime: number;
          _id: string;
          email?: string;
          emailVerificationTime?: number;
          extend?: any;
          hasTotp?: boolean;
          image?: string;
          isAnonymous?: boolean;
          lastActiveGroup?: string;
          name?: string;
          phone?: string;
          phoneVerificationTime?: number;
        }
      | null
      | Array<{
          _creationTime: number;
          _id: string;
          email?: string;
          emailVerificationTime?: number;
          extend?: any;
          hasTotp?: boolean;
          image?: string;
          isAnonymous?: boolean;
          lastActiveGroup?: string;
          name?: string;
          phone?: string;
          phoneVerificationTime?: number;
        } | null>,
      Name
    >;
    key: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          expiresAt?: number;
          extend?: any;
          hashedKey: string;
          name: string;
          prefix: string;
          rateLimit?: { maxRequests: number; windowMs: number };
          scopes: Array<{ actions: Array<string>; resource: string }>;
          userId: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { hashedKey?: string; id?: string },
        {
          _creationTime: number;
          _id: string;
          createdAt: number;
          expiresAt?: number;
          extend?: any;
          hashedKey: string;
          lastUsedAt?: number;
          name: string;
          prefix: string;
          rateLimit?: { maxRequests: number; windowMs: number };
          rateLimitState?: { attemptsLeft: number; lastAttemptTime: number };
          revoked: boolean;
          scopes: Array<{ actions: Array<string>; resource: string }>;
          userId: string;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          order?: "asc" | "desc";
          orderBy?: "_creationTime" | "name" | "lastUsedAt" | "expiresAt" | "revoked";
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          where?: {
            name?: string;
            prefix?: string;
            revoked?: boolean;
            userId?: string;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            createdAt: number;
            expiresAt?: number;
            extend?: any;
            hashedKey: string;
            lastUsedAt?: number;
            name: string;
            prefix: string;
            rateLimit?: { maxRequests: number; windowMs: number };
            rateLimitState?: {
              attemptsLeft: number;
              lastAttemptTime: number;
            };
            revoked: boolean;
            scopes: Array<{ actions: Array<string>; resource: string }>;
            userId: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      recordUse: FunctionReference<
        "mutation",
        "internal",
        { coarsenMs?: number; id: string; now: number },
        { limited: boolean },
        Name
      >;
      remove: FunctionReference<"mutation", "internal", { id: string }, null, Name>;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          id: string;
          patch: {
            lastUsedAt?: number;
            name?: string;
            rateLimit?: { maxRequests: number; windowMs: number };
            rateLimitState?: {
              attemptsLeft: number;
              lastAttemptTime: number;
            };
            revoked?: boolean;
            scopes?: Array<{ actions: Array<string>; resource: string }>;
          };
        },
        null,
        Name
      >;
    };
    list: FunctionReference<
      "query",
      "internal",
      {
        order?: "asc" | "desc";
        orderBy?: "_creationTime" | "name" | "email" | "phone";
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
        where?: {
          email?: string;
          isAnonymous?: boolean;
          name?: string;
          phone?: string;
        };
      },
      {
        continueCursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: string;
          email?: string;
          emailVerificationTime?: number;
          extend?: any;
          hasTotp?: boolean;
          image?: string;
          isAnonymous?: boolean;
          lastActiveGroup?: string;
          name?: string;
          phone?: string;
          phoneVerificationTime?: number;
        }>;
        pageStatus?: "SplitRecommended" | "SplitRequired" | null;
        splitCursor?: string | null;
      },
      Name
    >;
    remove: FunctionReference<
      "mutation",
      "internal",
      { cascade?: boolean; id: string },
      null,
      Name
    >;
    update: FunctionReference<
      "mutation",
      "internal",
      {
        id: string;
        patch: {
          email?: string;
          emailVerificationTime?: number;
          extend?: any;
          hasTotp?: boolean;
          image?: string;
          isAnonymous?: boolean;
          lastActiveGroup?: string;
          name?: string;
          phone?: string;
          phoneVerificationTime?: number;
        };
      },
      null,
      Name
    >;
    upsert: FunctionReference<
      "mutation",
      "internal",
      {
        data: {
          email?: string;
          emailVerificationTime?: number;
          extend?: any;
          hasTotp?: boolean;
          image?: string;
          isAnonymous?: boolean;
          lastActiveGroup?: string;
          name?: string;
          phone?: string;
          phoneVerificationTime?: number;
        };
        id?: string;
      },
      string,
      Name
    >;
  };
};
