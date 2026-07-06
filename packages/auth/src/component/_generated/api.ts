/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as connection from "../connection.js";
import type * as connection_audit from "../connection/audit.js";
import type * as connection_cache from "../connection/cache.js";
import type * as connection_domain from "../connection/domain.js";
import type * as connection_domain_verification from "../connection/domain/verification.js";
import type * as connection_saml_assertion from "../connection/saml/assertion.js";
import type * as connection_saml_request from "../connection/saml/request.js";
import type * as connection_scim_config from "../connection/scim/config.js";
import type * as connection_scim_identity from "../connection/scim/identity.js";
import type * as connection_secret from "../connection/secret.js";
import type * as connection_webhook_delivery from "../connection/webhook/delivery.js";
import type * as connection_webhook_endpoint from "../connection/webhook/endpoint.js";
import type * as crons from "../crons.js";
import type * as event from "../event.js";
import type * as factor_device from "../factor/device.js";
import type * as factor_passkey from "../factor/passkey.js";
import type * as factor_totp from "../factor/totp.js";
import type * as functions from "../functions.js";
import type * as group from "../group.js";
import type * as group_invite from "../group/invite.js";
import type * as group_member from "../group/member.js";
import type * as http from "../http.js";
import type * as index from "../index.js";
import type * as limits from "../limits.js";
import type * as maintenance from "../maintenance.js";
import type * as migrations from "../migrations.js";
import type * as model from "../model.js";
import type * as modules from "../modules.js";
import type * as oauth_client from "../oauth/client.js";
import type * as oauth_code from "../oauth/code.js";
import type * as oauth_refresh from "../oauth/refresh.js";
import type * as session from "../session.js";
import type * as token_pkce from "../token/pkce.js";
import type * as token_refresh from "../token/refresh.js";
import type * as token_verification from "../token/verification.js";
import type * as user from "../user.js";
import type * as user_email from "../user/email.js";
import type * as user_key from "../user/key.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  account: typeof account;
  connection: typeof connection;
  "connection/audit": typeof connection_audit;
  "connection/cache": typeof connection_cache;
  "connection/domain": typeof connection_domain;
  "connection/domain/verification": typeof connection_domain_verification;
  "connection/saml/assertion": typeof connection_saml_assertion;
  "connection/saml/request": typeof connection_saml_request;
  "connection/scim/config": typeof connection_scim_config;
  "connection/scim/identity": typeof connection_scim_identity;
  "connection/secret": typeof connection_secret;
  "connection/webhook/delivery": typeof connection_webhook_delivery;
  "connection/webhook/endpoint": typeof connection_webhook_endpoint;
  crons: typeof crons;
  event: typeof event;
  "factor/device": typeof factor_device;
  "factor/passkey": typeof factor_passkey;
  "factor/totp": typeof factor_totp;
  functions: typeof functions;
  group: typeof group;
  "group/invite": typeof group_invite;
  "group/member": typeof group_member;
  http: typeof http;
  index: typeof index;
  limits: typeof limits;
  maintenance: typeof maintenance;
  migrations: typeof migrations;
  model: typeof model;
  modules: typeof modules;
  "oauth/client": typeof oauth_client;
  "oauth/code": typeof oauth_code;
  "oauth/refresh": typeof oauth_refresh;
  session: typeof session;
  "token/pkce": typeof token_pkce;
  "token/refresh": typeof token_refresh;
  "token/verification": typeof token_verification;
  user: typeof user;
  "user/email": typeof user_email;
  "user/key": typeof user_key;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  stream: import("@convex-dev/stream/_generated/component.js").ComponentApi<"stream">;
  webhookWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"webhookWorkpool">;
  connectionFetchCache: import("@convex-dev/action-cache/_generated/component.js").ComponentApi<"connectionFetchCache">;
};
