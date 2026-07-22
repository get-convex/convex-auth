import type { GenericActionCtx, GenericDataModel, HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { serialize as serializeCookie } from "cookie";

import { configDefaults } from "../config";
import {
  getScimIdentity,
  getScimIdentityByConnectionAndUser,
  getScimIdentityByMappedGroup,
  insertAccount,
  insertUser,
  listScimIdentitiesByConnection,
  removeScimIdentity,
  updateUser,
  upsertScimIdentity,
  type ScimIdentityRecord,
} from "../contract";
import { redirectToParamCookie, useRedirectToParam } from "../cookies";
import { convexError } from "../errors";
import { ErrorCode } from "../../shared/codes";
import { addConnectionRoutes, convertErrorsToResponse, getCookies } from "../http";
import type { ConnectionRuntimeRoute } from "../http";
import { log } from "../log";
import { createOAuthAuthorizationURL, handleOAuthCallback } from "../oauth/runtime";
import type { AuthAccountExtend, AuthProfile } from "../payloads";
import { redirectAbsoluteUrl, setURLSearchParam } from "../redirects";
import type { AuthEventKind, AuthEventObject, AuthEventSubject } from "../events";
import type { EmitGroupAuthEventInput } from "./group/service";
import type { GroupConnectionPolicy } from "../types";
import { createGroupConnectionOidcRuntime } from "./oidc";
import { resolveProvisionedRoleIds } from "./policy";
import { finalizeNormalizedProfile, normalizeStringArray } from "./profile";
import {
  createGroupConnectionSamlMetadataXml,
  createGroupConnectionSamlSignInRequest,
  createSamlPostBindingResponse,
  encodeGroupSamlRelayState,
  enforceGroupConnectionSamlSecurity,
  getSamlServiceProviderOptions,
  parseGroupConnectionSamlLoginResponse,
  parseGroupConnectionSamlLogoutMessage,
  profileFromSamlExtract,
  samlReplayIdentifiers,
  validateGroupConnectionSamlLoginRelayState,
} from "./saml";
import {
  parseScimListRequest,
  scimError,
  scimJson,
  serializeScimGroup,
  serializeScimUser,
} from "./scim";
import {
  decodeGroupOidcState,
  encodeGroupOidcState,
  groupOidcProviderId,
  groupSamlProviderId,
  SCIM_GROUP_SCHEMA_ID,
  SCIM_USER_SCHEMA_ID,
} from "./shared";

type ComponentConfig = ReturnType<typeof configDefaults>;

type AuthRuntime = {
  user: {
    get(ctx: GenericActionCtx<GenericDataModel>, args: { id: string }): Promise<UserRecord | null>;
  };
  group: {
    get(ctx: GenericActionCtx<GenericDataModel>, args: { id: string }): Promise<GroupRecord | null>;
    list(
      ctx: GenericActionCtx<GenericDataModel>,
      opts: {
        where?: Record<string, unknown>;
        paginationOpts: { numItems: number; cursor: string | null };
      },
    ): Promise<{ page: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string }>;
    create(
      ctx: GenericActionCtx<GenericDataModel>,
      args: { data: { name: string; parentGroupId: string; type: string } },
    ): Promise<string>;
    update(
      ctx: GenericActionCtx<GenericDataModel>,
      args: { id: string; patch: Record<string, unknown> },
    ): Promise<unknown>;
    remove(ctx: GenericActionCtx<GenericDataModel>, args: { id: string }): Promise<unknown>;
  };
  member: {
    list(
      ctx: GenericActionCtx<GenericDataModel>,
      opts: {
        where?: Record<string, unknown>;
        paginationOpts: { numItems: number; cursor: string | null };
      },
    ): Promise<{
      page: Array<{ _id: string; userId: string; status?: string }>;
      isDone: boolean;
      continueCursor: string;
    }>;
    create(
      ctx: GenericActionCtx<GenericDataModel>,
      args: {
        data: {
          groupId: string;
          userId: string;
          roleIds: string[];
          status: string;
        };
      },
    ): Promise<unknown>;
    update(
      ctx: GenericActionCtx<GenericDataModel>,
      args: { id: string; patch: Record<string, unknown> },
    ): Promise<unknown>;
    remove(ctx: GenericActionCtx<GenericDataModel>, args: { id: string }): Promise<unknown>;
    get(
      ctx: GenericActionCtx<GenericDataModel>,
      args: { groupId: string; userId: string },
    ): Promise<{ membership: { _id: string } | null }>;
  };
};

type ActiveSamlConnection = {
  loaded: {
    source: { kind: "connection"; id: string };
    config: unknown;
    [key: string]: unknown;
  };
  connection: { _id: string; groupId: string };
  saml: Record<string, unknown>;
};

type OidcConnection = {
  connection: { _id: string; groupId: string };
  oidc: Record<string, unknown>;
};

type ScimContext = {
  parsedPath: {
    connectionId: string;
    resource: string;
    resourceId?: string;
  };
  connection: { _id: string; groupId: string; protocol: "oidc" | "saml" };
  scimConfig: {
    _id: string;
    connectionId: string;
    status: string;
    extend?: unknown;
  };
};

type GroupPolicy = GroupConnectionPolicy;

type CookieToSerialize = {
  name: string;
  value: string;
  options: Parameters<typeof serializeCookie>[2];
};

function formDataEntries(formData: unknown): Iterable<[string, string | { name: string }]> {
  return formData as Iterable<[string, string | { name: string }]>;
}

async function getOidcCallbackParams(request: Request) {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.searchParams);
  if (request.headers.get("Content-Type")?.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    for (const [key, value] of formDataEntries(formData)) {
      if (typeof value === "string") {
        params.append(key, value);
      }
    }
  }
  return params;
}

type MemberRecord = { _id: string; userId: string; status?: string };
type UserRecord = { _id: string; email?: string } & Record<string, unknown>;
type GroupRecord = { _id: string; name?: string } & Record<string, unknown>;

type UserListItem = {
  user: UserRecord;
  member: MemberRecord;
  identity?: ScimIdentityRecord;
};

type GroupListItem = {
  group: GroupRecord;
  identity?: ScimIdentityRecord;
  memberIds?: string[];
};

type GroupHttpRuntimeDeps = {
  http: HttpRouter;
  hasConnection: boolean;
  auth: AuthRuntime;
  config: ComponentConfig;
  routeBase: string;
  requireEnv: (name: string) => string;
  loadActiveConnectionSamlOrThrow: (
    ctx: GenericActionCtx<GenericDataModel>,
    connectionId: string,
  ) => Promise<ActiveSamlConnection>;
  loadConnectionOidcOrThrow: (
    ctx: GenericActionCtx<GenericDataModel>,
    connectionId: string,
  ) => Promise<OidcConnection>;
  getGroupConnectionScimContext: (
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
  ) => Promise<ScimContext>;
  loadGroupPolicyOrThrow: (
    ctx: GenericActionCtx<GenericDataModel>,
    groupId: string,
  ) => Promise<GroupPolicy>;
  normalizeGroupConnectionPolicy: (policy: unknown) => GroupPolicy;
  emitGroupAuthEvent: (
    ctx: GenericActionCtx<GenericDataModel>,
    args: EmitGroupAuthEventInput,
  ) => Promise<string>;
  generateRandomString: (length: number, alphabet: string) => string;
  inviteTokenAlphabet: string;
  callUserOAuth: (
    ctx: GenericActionCtx<GenericDataModel>,
    args: {
      provider: string;
      providerAccountId: string;
      signature: string;
      profile: AuthProfile;
      accountExtend?: AuthAccountExtend;
    },
  ) => Promise<string>;
  callVerifierSignature: (
    ctx: GenericActionCtx<GenericDataModel>,
    args: { verifier: string; signature: string },
  ) => Promise<void>;
  sharedOidcRedirectURI?: string;
};

type ScimFilterOperator = NonNullable<
  ReturnType<typeof parseScimListRequest>["filter"]
>["operator"];

/**
 * Upper bound on rows a single SCIM list response will materialize. SCIM list
 * filtering and `totalResults` require the full member/group set, so the
 * handlers cursor-follow to this cap; past it the response is truncated and a
 * warning is logged rather than silently returning a partial first page.
 */
const SCIM_COLLECT_LIMIT = 5000;

/**
 * Lifetime of a persisted pending SAML AuthnRequest. Bounds how long an ACS
 * response can accept the request; comfortably covers IdP round-trips and the
 * default 300s clock skew while keeping the pending-request table small.
 */
const SAML_LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * Fallback TTL for the seen-assertion replay cache when an assertion carries no
 * `NotOnOrAfter` bound (only reachable when `requireTimestamps` is disabled).
 */
const SAML_SEEN_ASSERTION_FALLBACK_TTL_MS = 10 * 60 * 1000;

const SCIM_FILTER_OPERATORS: Record<
  ScimFilterOperator,
  (values: string[], filterValue: string) => boolean
> = {
  pr: (values) => values.length > 0,
  eq: (values, filterValue) => values.includes(filterValue),
  co: (values, filterValue) => values.some((value) => value.includes(filterValue)),
  sw: (values, filterValue) => values.some((value) => value.startsWith(filterValue)),
  ew: (values, filterValue) => values.some((value) => value.endsWith(filterValue)),
};

export function addGroupHttpRuntime(deps: GroupHttpRuntimeDeps) {
  if (!deps.hasConnection) {
    return;
  }

  const {
    http,
    auth,
    config,
    requireEnv,
    loadActiveConnectionSamlOrThrow,
    loadConnectionOidcOrThrow,
    getGroupConnectionScimContext,
    loadGroupPolicyOrThrow,
    emitGroupAuthEvent,
    generateRandomString,
    inviteTokenAlphabet: INVITE_TOKEN_ALPHABET,
    callUserOAuth,
    callVerifierSignature,
    sharedOidcRedirectURI,
  } = deps;
  const GROUP_CONNECTION_ROUTE_BASE = deps.routeBase;

  type ScimState = {
    ctx: GenericActionCtx<GenericDataModel>;
    request: Request;
    url: URL;
    parsedPath: ScimContext["parsedPath"];
    connection: ScimContext["connection"];
    scimConfig: ScimContext["scimConfig"];
    policy: GroupPolicy;
    recordScimEvent: (
      kind: AuthEventKind,
      outcome: "success" | "failure",
      subject: AuthEventSubject,
      data?: Record<string, unknown>,
    ) => Promise<void>;
  };

  type ScimHandler = (state: ScimState) => Promise<Response>;

  const errorCodeForEvent = (error: unknown, fallback: string) => {
    if (
      error instanceof ConvexError &&
      typeof error.data === "object" &&
      error.data !== null &&
      "code" in error.data &&
      typeof (error.data as { code?: unknown }).code === "string"
    ) {
      return (error.data as { code: string }).code;
    }
    return fallback;
  };

  const recordConnectionLoginEvent = async (
    ctx: GenericActionCtx<GenericDataModel>,
    args: {
      connection: { _id: string; groupId: string };
      protocol: "oidc" | "saml";
      outcome: "success" | "failure";
      userId?: string;
      error?: unknown;
    },
  ) => {
    await emitGroupAuthEvent(ctx, {
      connectionId: args.connection._id,
      groupId: args.connection.groupId,
      kind: args.outcome === "success" ? "connection.login.succeeded" : "connection.login.failed",
      actor: { type: "anonymous" },
      subject: args.userId
        ? { type: "user", id: args.userId }
        : { type: "connection", id: args.connection._id },
      outcome: args.outcome,
      data:
        args.outcome === "success"
          ? {
              connectionId: args.connection._id,
              protocol: args.protocol,
              userId: args.userId,
            }
          : {
              connectionId: args.connection._id,
              protocol: args.protocol,
              errorCode: errorCodeForEvent(args.error, "OAUTH_PROVIDER_ERROR"),
            },
    });
  };

  /**
   * Enforce server-side SAML replay prevention at the ACS.
   *
   * The signature, audience/recipient/timestamp, and `InResponseTo` checks that
   * ran earlier all travel inside the same replayable POST, so none of them can
   * tell a captured `SAMLResponse` from a resubmitted one. This consumes the
   * single-use pending request (defeating SP-initiated replay) and records the
   * assertion ID in a bounded seen-cache (defeating IdP-initiated replay, which
   * carries no `InResponseTo`). Either check failing means the response was
   * already used: a connection-login failure is emitted and the login is
   * rejected with no session. Throws (never returns) on rejection.
   */
  const enforceSamlAcsReplayDefense = async (
    ctx: GenericActionCtx<GenericDataModel>,
    connection: { _id: string; groupId: string },
    parsed: {
      samlContent: string;
      extract?: Parameters<typeof samlReplayIdentifiers>[0]["extract"];
    },
  ): Promise<void> => {
    const nowMs = Date.now();
    const { assertionId, inResponseTo, notOnOrAfter } = samlReplayIdentifiers(parsed);
    const rejectReplay = async (message: string): Promise<never> => {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "saml",
        outcome: "failure",
        error: new Error(message),
      });
      throw convexError(ErrorCode.OAUTH_INVALID_STATE, message);
    };

    if (typeof inResponseTo === "string" && inResponseTo.length > 0) {
      const accepted = (await ctx.runMutation(config.component.connection.saml.request.accept, {
        requestId: inResponseTo,
        now: nowMs,
        connectionId: connection._id,
      })) as boolean;
      if (!accepted) {
        await rejectReplay("SAML response replays or references an unknown login request.");
      }
    }

    if (typeof assertionId !== "string" || assertionId.length === 0) {
      await rejectReplay("SAML assertion is missing an ID required for replay detection.");
    }
    const expiresAtMs =
      typeof notOnOrAfter === "string" && Number.isFinite(new Date(notOnOrAfter).getTime())
        ? new Date(notOnOrAfter).getTime()
        : nowMs + SAML_SEEN_ASSERTION_FALLBACK_TTL_MS;
    const firstSeen = (await ctx.runMutation(config.component.connection.saml.assertion.accept, {
      connectionId: connection._id,
      assertionId: assertionId as string,
      expiresAt: expiresAtMs,
    })) as boolean;
    if (!firstSeen) {
      await rejectReplay("SAML assertion has already been used.");
    }
  };

  const SCIM_SCHEMAS = [
    {
      id: SCIM_USER_SCHEMA_ID,
      name: "User",
      description: "User Account",
      attributes: [
        { name: "userName", type: "string", required: true },
        { name: "displayName", type: "string" },
        { name: "active", type: "boolean" },
        { name: "emails", type: "complex", multiValued: true },
      ],
    },
    {
      id: SCIM_GROUP_SCHEMA_ID,
      name: "Group",
      description: "Group",
      attributes: [
        { name: "displayName", type: "string", required: true },
        { name: "members", type: "complex", multiValued: true },
      ],
    },
  ] as const;

  const SCIM_RESOURCE_TYPES = [
    {
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_USER_SCHEMA_ID,
    },
    {
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP_SCHEMA_ID,
    },
  ] as const;

  const handleStaticScimCollection = <T extends { id?: string; name?: string }>(
    items: readonly T[],
    resourceId: string | undefined,
    opts: { by: "id" | "name"; notFound: string },
  ) => {
    if (resourceId !== undefined) {
      const item = items.find((entry) => entry[opts.by] === decodeURIComponent(resourceId));
      return item ? scimJson(item) : scimError(404, "notFound", opts.notFound);
    }
    return scimJson({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      Resources: items,
      totalResults: items.length,
      startIndex: 1,
      itemsPerPage: items.length,
    });
  };

  const pickPrimaryEmail = (body: ScimBody) =>
    Array.isArray(body.emails)
      ? (body.emails.find((entry) => entry.primary === true)?.value ?? body.emails[0]?.value)
      : undefined;

  const pickDisplayName = (body: ScimBody) => {
    const name = typeof body.name === "object" && body.name !== null ? body.name : undefined;
    const derivedName = [name?.givenName, name?.familyName].filter(Boolean).join(" ");
    if (body.displayName !== undefined) {
      return body.displayName;
    }
    if (name?.formatted !== undefined) {
      return name.formatted;
    }
    return derivedName !== "" ? derivedName : undefined;
  };

  const pickPhone = (body: ScimBody) =>
    Array.isArray(body.phoneNumbers) ? body.phoneNumbers[0]?.value : undefined;

  const getScimProfileConfig = (scimConfig: { extend?: unknown } | null | undefined) => {
    const extend =
      typeof scimConfig?.extend === "object" && scimConfig.extend !== null
        ? (scimConfig.extend as Record<string, unknown>)
        : {};
    const profile =
      typeof extend.profile === "object" && extend.profile !== null
        ? (extend.profile as Record<string, unknown>)
        : {};
    return {
      mapping:
        typeof profile.mapping === "object" && profile.mapping !== null
          ? (profile.mapping as Record<string, string>)
          : {},
      extraFields:
        typeof profile.extraFields === "object" && profile.extraFields !== null
          ? (profile.extraFields as Record<string, string>)
          : {},
    };
  };

  const scimFieldAccessors: Record<string, (body: ScimBody) => unknown> = {
    userName: (body) => body.userName,
    externalId: (body) => body.externalId,
    displayName: (body) => body.displayName,
    "name.formatted": (body) => body.name?.formatted,
    "name.givenName": (body) => body.name?.givenName,
    "name.familyName": (body) => body.name?.familyName,
    "emails.primary": (body) => pickPrimaryEmail(body),
    "emails.value": (body) =>
      Array.isArray(body.emails)
        ? body.emails.map((entry) => entry.value).filter(Boolean)
        : undefined,
    "phoneNumbers.primary": (body) => pickPhone(body),
    "phoneNumbers.value": (body) => pickPhone(body),
    active: (body) => body.active,
    groups: (body) => (body as Record<string, unknown>).groups,
    roles: (body) => (body as Record<string, unknown>).roles,
  };

  const resolveScimField = (body: ScimBody, key: string | undefined) => {
    if (!key) {
      return undefined;
    }
    const accessor = scimFieldAccessors[key];
    return accessor ? accessor(body) : (body as Record<string, unknown>)[key];
  };

  const extractScimProfile = (
    scimConfig: { extend?: unknown } | null | undefined,
    body: ScimBody,
  ) => {
    const { mapping, extraFields } = getScimProfileConfig(scimConfig);
    const extend = Object.fromEntries(
      Object.entries(extraFields)
        .map(([fieldName, source]) => [fieldName, resolveScimField(body, source)])
        .filter(([, value]) => value !== undefined),
    );

    return finalizeNormalizedProfile({
      externalId:
        (resolveScimField(body, mapping.externalId) as string | undefined) ??
        (typeof body.externalId === "string" ? body.externalId : undefined),
      name: (resolveScimField(body, mapping.name) as string | undefined) ?? pickDisplayName(body),
      firstName: resolveScimField(body, mapping.firstName) as string | undefined,
      lastName: resolveScimField(body, mapping.lastName) as string | undefined,
      email:
        (resolveScimField(body, mapping.email) as string | undefined) ??
        pickPrimaryEmail(body) ??
        body.userName,
      phone: (resolveScimField(body, mapping.phone) as string | undefined) ?? pickPhone(body),
      active: (resolveScimField(body, mapping.active) as boolean | undefined) ?? body.active,
      groups: pickStringArray(resolveScimField(body, mapping.groups)),
      roles: pickStringArray(resolveScimField(body, mapping.roles)),
      extend: Object.keys(extend).length > 0 ? extend : undefined,
    });
  };

  const pickStringArray = (value: unknown) => {
    return normalizeStringArray(
      Array.isArray(value)
        ? value.map((entry) => {
            if (typeof entry === "string") {
              return entry;
            }
            if (
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { value?: unknown }).value === "string"
            ) {
              return (entry as { value: string }).value;
            }
            return undefined;
          })
        : value,
    );
  };

  const normalizeScimValues = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => normalizeScimValues(entry));
    }
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "boolean") {
      return [String(value)];
    }
    return [];
  };

  const applyUserProvisioningPatch = (args: {
    currentUser: Record<string, unknown>;
    nextUser: Record<string, unknown>;
    policy: {
      authority?: "app" | "connection" | "scim";
      updateProfileOnLogin?: "never" | "missing" | "always";
      updateProfileFromScim?: "never" | "missing" | "always";
    };
    source: "scim";
  }) => {
    const mode = args.policy.updateProfileFromScim ?? "always";
    if (mode === "never") {
      return {};
    }
    if (mode === "always") {
      return args.nextUser;
    }
    return Object.fromEntries(
      Object.entries(args.nextUser).filter(([key, value]) => {
        if (value === undefined) {
          return false;
        }
        const current = args.currentUser[key];
        return current === undefined || current === null || current === "";
      }),
    );
  };

  const filterScimCollection = <T>(
    items: T[],
    filter: ReturnType<typeof parseScimListRequest>["filter"],
    filters: Record<string, (item: T) => unknown>,
  ) => {
    if (!filter) {
      return items;
    }
    const accessor = filters[filter.attribute];
    if (!accessor) {
      throw new Error("Unsupported SCIM filter.");
    }
    const matchesOperator = SCIM_FILTER_OPERATORS[filter.operator];
    return items.filter((item) =>
      matchesOperator(normalizeScimValues(accessor(item)), filter.value ?? ""),
    );
  };

  const paginateScimCollection = <T>(
    items: T[],
    listRequest: ReturnType<typeof parseScimListRequest>,
  ) => {
    const start = listRequest.startIndex - 1;
    return items.slice(start, start + listRequest.count);
  };

  const requireScimResourceId = (resourceId: string | undefined, label: string) => {
    if (!resourceId) {
      return scimError(400, "invalidPath", `${label} resource ID is required.`);
    }
    return null;
  };

  const readScimJson = async (request: Request) => {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (
      contentType &&
      !contentType.includes("application/scim+json") &&
      !contentType.includes("application/json")
    ) {
      throw new Error("Unsupported SCIM content type.");
    }
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid SCIM JSON.");
    }
  };

  const unsupportedScimPatch = (): never => {
    throw new Error("Unsupported SCIM PATCH operation.");
  };

  const scimCollectOverflow = () => new Error("SCIM member set too large to reconcile.");

  type ScimBody = Record<string, unknown> & {
    displayName?: string;
    userName?: string;
    active?: boolean;
    externalId?: string;
    emails?: Array<{ value?: string; primary?: boolean }>;
    phoneNumbers?: Array<{ value?: string }>;
    name?: { formatted?: string; givenName?: string; familyName?: string };
    Operations?: Array<{ op?: string; path?: string; value?: unknown }>;
    members?: Array<{ value?: string }>;
  };

  const handleSamlAcs = async (
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
    runtimeRoute: ConnectionRuntimeRoute,
  ) => {
    if (
      runtimeRoute.protocol !== "saml" ||
      runtimeRoute.rest.length !== 1 ||
      runtimeRoute.rest[0] !== "acs"
    ) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Invalid connection runtime path.");
    }

    const connectionId = runtimeRoute.connectionId;
    const loadedConnection = await loadActiveConnectionSamlOrThrow(ctx, connectionId);
    const { loaded, connection, saml } = loadedConnection;
    const rootUrl = requireEnv("CONVEX_SITE_URL");
    const serviceProvider = getSamlServiceProviderOptions({
      rootUrl,
      source: { kind: "connection", id: connection._id },
      config: loaded.config,
    });

    let parsedResponse;
    try {
      parsedResponse = await parseGroupConnectionSamlLoginResponse({
        request,
        rootUrl,
        source: { kind: "connection", id: connection._id },
        config: loaded.config,
      });
    } catch (error) {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "saml",
        outcome: "failure",
        error,
      });
      throw convexError(
        "OAUTH_PROVIDER_ERROR",
        `SAML response parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      enforceGroupConnectionSamlSecurity({
        extract: parsedResponse.parsed.extract,
        config: loaded.config,
        expectedAudience: serviceProvider.entityId,
        expectedAcsUrl: serviceProvider.acsUrl,
      });
    } catch (error) {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "saml",
        outcome: "failure",
        error,
      });
      throw convexError(
        "OAUTH_PROVIDER_ERROR",
        error instanceof Error ? error.message : "SAML assertion failed security validation.",
      );
    }

    try {
      validateGroupConnectionSamlLoginRelayState({
        relayState: parsedResponse.relayState,
        source: { kind: "connection", id: connection._id },
        inResponseTo: parsedResponse.parsed.extract?.subjectConfirmation?.inResponseTo,
      });
    } catch (error) {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "saml",
        outcome: "failure",
        error,
      });
      throw convexError(
        "OAUTH_INVALID_STATE",
        "SAML RelayState did not match the pending login request.",
      );
    }

    await enforceSamlAcsReplayDefense(ctx, connection, parsedResponse.parsed);

    const { samlAttributes, samlSessionIndex, ...userProfile } = profileFromSamlExtract(
      parsedResponse.parsed.extract,
      ((saml.profile as Record<string, unknown> | undefined)?.mapping ?? {}) as
        | Record<string, string>
        | undefined,
    );
    const profile = userProfile as Record<string, unknown> & {
      id: string;
    };
    const extraFields =
      typeof saml.profile === "object" && saml.profile !== null
        ? ((saml.profile as Record<string, unknown>).extraFields as
            | Record<string, string>
            | undefined)
        : undefined;
    if (extraFields) {
      const extend: Record<string, unknown> = {};
      for (const [fieldName, attributeName] of Object.entries(extraFields)) {
        const value = samlAttributes[attributeName];
        if (value !== undefined) {
          extend[fieldName] = value;
        }
      }
      if (Object.keys(extend).length > 0) {
        profile.extend = extend;
      }
    }

    const maybeRedirectTo = useRedirectToParam(
      groupSamlProviderId(connection._id),
      getCookies(request),
    );

    let verificationCode: string;
    try {
      verificationCode = await callUserOAuth(ctx, {
        provider: groupSamlProviderId(connection._id),
        providerAccountId: profile.id,
        profile: profile as AuthProfile,
        signature: parsedResponse.relayState.signature,
        accountExtend: {
          identity: {
            protocol: "saml",
            connectionId: connection._id,
            subject: profile.id,
            entityId: typeof saml.entityId === "string" ? saml.entityId : undefined,
          },
          saml: {
            attributes: samlAttributes as Record<string, string | string[]>,
            sessionIndex: samlSessionIndex,
          },
        },
      });
    } catch (error) {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "saml",
        outcome: "failure",
        error,
      });
      throw error;
    }
    await recordConnectionLoginEvent(ctx, {
      connection,
      protocol: "saml",
      outcome: "success",
    });

    const destinationUrl = await redirectAbsoluteUrl(ctx, config, {
      redirectTo:
        maybeRedirectTo?.redirectTo ??
        (typeof parsedResponse.relayState.redirectTo === "string"
          ? parsedResponse.relayState.redirectTo
          : undefined),
    });

    const vurl = setURLSearchParam(destinationUrl, "code", verificationCode);
    const vheaders = new Headers({ Location: vurl });
    vheaders.set("Cache-Control", "must-revalidate");
    for (const { name, value, options } of maybeRedirectTo !== null
      ? [maybeRedirectTo.updatedCookie]
      : []) {
      vheaders.append("Set-Cookie", serializeCookie(name, value, options));
    }
    return new Response(null, { status: 302, headers: vheaders });
  };

  const handleSamlSlo = async (
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
    runtimeRoute: ConnectionRuntimeRoute,
  ) => {
    type LogoutResponseContext = { context: string; entityEndpoint: string };
    if (
      runtimeRoute.protocol !== "saml" ||
      runtimeRoute.rest.length !== 1 ||
      runtimeRoute.rest[0] !== "slo"
    ) {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Invalid connection runtime path.");
    }
    const { loaded, connection } = await loadActiveConnectionSamlOrThrow(
      ctx,
      runtimeRoute.connectionId,
    );
    const parsedMessage = await parseGroupConnectionSamlLogoutMessage({
      request,
      rootUrl: requireEnv("CONVEX_SITE_URL"),
      source: { kind: "connection", id: connection._id },
      config: loaded.config,
    });
    if (parsedMessage.hasSamlRequest) {
      if (!parsedMessage.parsedRequest) {
        throw convexError(ErrorCode.INVALID_PARAMETERS, "Missing SAML logout payload.");
      }
      const responseContext = parsedMessage.runtime.sp.createLogoutResponse(
        parsedMessage.runtime.idp,
        parsedMessage.parsedRequest.extract,
        parsedMessage.binding,
        parsedMessage.relayState ?? "",
      ) as unknown as LogoutResponseContext;
      if (parsedMessage.binding === "redirect") {
        return new Response(null, {
          status: 302,
          headers: { Location: responseContext.context },
        });
      }
      return createSamlPostBindingResponse({
        endpoint: responseContext.entityEndpoint,
        parameter: "SAMLResponse",
        value: responseContext.context,
        relayState: parsedMessage.relayState,
      });
    } else if (parsedMessage.hasSamlResponse) {
      if (!parsedMessage.parsedResponse) {
        throw convexError(ErrorCode.INVALID_PARAMETERS, "Missing SAML logout response payload.");
      }
      return new Response(null, { status: 204 });
    } else {
      throw convexError(ErrorCode.INVALID_PARAMETERS, "Missing SAML logout payload.");
    }
  };

  const handleScimRequest = async (ctx: GenericActionCtx<GenericDataModel>, request: Request) => {
    try {
      const { scimConfig, connection, parsedPath } = await getGroupConnectionScimContext(
        ctx,
        request,
      );
      const url = new URL(request.url);
      const state: ScimState = {
        ctx,
        request,
        url,
        parsedPath,
        connection,
        scimConfig,
        policy: await loadGroupPolicyOrThrow(ctx, connection.groupId),
        recordScimEvent: async (kind, outcome, subject, data) => {
          try {
            await emitGroupAuthEvent(ctx, {
              connectionId: connection._id,
              groupId: connection.groupId,
              kind,
              actor: { type: "scim" },
              subject,
              outcome,
              data,
              webhook: {
                payload: {
                  connectionId: connection._id,
                  ...(subject.id ? { subjectId: subject.id } : {}),
                  ...(data ? { data: data as AuthEventObject } : {}),
                },
              },
            });
          } catch (error) {
            log("WARN", "[connection.scim] audit event emit failed (best-effort)", { kind, error });
          }
        },
      };

      const collectMembers = async (
        ctx: GenericActionCtx<GenericDataModel>,
        where: { groupId: string; status?: "active" },
      ) => {
        const first = await auth.member.list(ctx, {
          where,
          paginationOpts: { numItems: 200, cursor: null },
        });
        const out = [...first.page];
        let cursor = first.continueCursor;
        let done = first.isDone;
        while (!done && out.length < SCIM_COLLECT_LIMIT) {
          const next = await auth.member.list(ctx, {
            where,
            paginationOpts: { numItems: 200, cursor },
          });
          out.push(...next.page);
          done = next.isDone;
          cursor = next.continueCursor;
        }
        if (!done) {
          log("WARN", "[connection.scim] member list truncated at collect limit", {
            groupId: where.groupId,
            limit: SCIM_COLLECT_LIMIT,
          });
        }
        return out;
      };

      /**
       * Fully enumerate a group's active members for an authoritative
       * (destructive) membership replace. Unlike {@link collectMembers}, this
       * refuses to truncate: a `replace` diffs the incoming set against the
       * current set and removes the difference, so a partial read would
       * silently drop overflow members. Throws {@link scimCollectOverflow} past
       * the collect limit so the caller fails the reconcile (413) rather than
       * completing a partial authoritative replace.
       */
      const collectMembersForReplace = async (
        ctx: GenericActionCtx<GenericDataModel>,
        where: { groupId: string; status?: "active" },
      ) => {
        const first = await auth.member.list(ctx, {
          where,
          paginationOpts: { numItems: 200, cursor: null },
        });
        const out = [...first.page];
        let cursor = first.continueCursor;
        let done = first.isDone;
        while (!done) {
          if (out.length > SCIM_COLLECT_LIMIT) {
            throw scimCollectOverflow();
          }
          const next = await auth.member.list(ctx, {
            where,
            paginationOpts: { numItems: 200, cursor },
          });
          out.push(...next.page);
          done = next.isDone;
          cursor = next.continueCursor;
        }
        return out;
      };

      const collectGroups = async (
        ctx: GenericActionCtx<GenericDataModel>,
        where: { parentGroupId: string },
      ) => {
        const first = await auth.group.list(ctx, {
          where,
          paginationOpts: { numItems: 200, cursor: null },
        });
        const out = [...first.page];
        let cursor = first.continueCursor;
        let done = first.isDone;
        while (!done && out.length < SCIM_COLLECT_LIMIT) {
          const next = await auth.group.list(ctx, {
            where,
            paginationOpts: { numItems: 200, cursor },
          });
          out.push(...next.page);
          done = next.isDone;
          cursor = next.continueCursor;
        }
        if (!done) {
          log("WARN", "[connection.scim] group list truncated at collect limit", {
            parentGroupId: where.parentGroupId,
            limit: SCIM_COLLECT_LIMIT,
          });
        }
        return out;
      };

      const userInConnectionScope = async (state: ScimState, userId: string) => {
        const identity = await getScimIdentityByConnectionAndUser(
          state.ctx,
          config.component.connection,
          { connectionId: state.connection._id, userId },
        );
        if (identity) {
          return true;
        }
        const existing = (
          await auth.member.list(state.ctx, {
            where: { groupId: state.connection.groupId, userId },
            paginationOpts: { numItems: 1, cursor: null },
          })
        ).page[0];
        return existing !== undefined;
      };

      const firstInvalidScimMember = async (state: ScimState, userIds: Iterable<string>) => {
        for (const userId of userIds) {
          const user = await auth.user.get(state.ctx, { id: userId });
          if (!user || !(await userInConnectionScope(state, userId))) {
            return userId;
          }
        }
        return null;
      };

      const handleUsersGet: ScimHandler = async (state) => {
        if (state.parsedPath.resourceId) {
          const userId = state.parsedPath.resourceId;
          const user = await auth.user.get(state.ctx, { id: userId });
          const identity = await getScimIdentityByConnectionAndUser(
            state.ctx,
            config.component.connection,
            { connectionId: state.connection._id, userId },
          );
          const membership = (
            await auth.member.list(state.ctx, {
              where: { groupId: state.connection.groupId, userId },
              paginationOpts: { numItems: 1, cursor: null },
            })
          ).page[0];
          if (!user || !membership) {
            return scimError(404, "notFound", "User not found.");
          }
          const typedUser = user as UserRecord;
          await state.recordScimEvent(
            "connection.scim.read",
            "success",
            { type: "user", id: typedUser._id },
            { resourceType: "user", resourceId: typedUser._id, operation: "get" },
          );
          const location = `${state.url.origin}${state.url.pathname.replace(/\/[^/]+$/, "")}/${typedUser._id}`;
          return scimJson(
            serializeScimUser({
              id: typedUser._id,
              user: typedUser,
              externalId: identity?.externalId,
              location,
              active: identity?.active ?? membership?.status === "active",
            }),
            200,
            { Location: location },
          );
        }
        const members = {
          page: await collectMembers(state.ctx, { groupId: state.connection.groupId }),
        };
        const identities = await listScimIdentitiesByConnection(
          state.ctx,
          config.component.connection,
          state.connection._id,
        );
        const identityByUserId = new Map(
          identities
            .filter(
              (identity: ScimIdentityRecord): identity is ScimIdentityRecord & { userId: string } =>
                typeof identity.userId === "string",
            )
            .map((identity: ScimIdentityRecord & { userId: string }) => [
              identity.userId,
              identity,
            ]),
        );
        const users = (
          await Promise.all(
            members.page.map(async (member) => {
              const user = await auth.user.get(state.ctx, { id: member.userId });
              const typedUser = user as UserRecord | null;
              return user
                ? {
                    user: typedUser,
                    member,
                    identity: identityByUserId.get(typedUser!._id),
                  }
                : null;
            }),
          )
        ).filter(Boolean) as UserListItem[];
        const listRequest = parseScimListRequest(state.url);
        const filtered = filterScimCollection<UserListItem>(users, listRequest.filter, {
          id: (item) => item.user._id,
          externalId: (item) => item.identity?.externalId,
          userName: (item) => item.user.email ?? item.user.phone ?? item.user.name ?? item.user._id,
          displayName: (item) => item.user.name,
          name: (item) => item.user.name,
          "name.formatted": (item) => item.user.name,
          "name.givenName": (item) => item.user.name,
          "name.familyName": (item) => item.user.name,
          "emails.value": (item) => item.user.email,
          "phoneNumbers.value": (item) => item.user.phone,
          active: (item) => item.identity?.active ?? item.member.status === "active",
        });
        const paged = paginateScimCollection(filtered, listRequest);
        await state.recordScimEvent(
          "connection.scim.read",
          "success",
          {
            type: "connection",
            id: state.connection._id,
          },
          {
            resourceType: "user",
            operation: "list",
          },
        );
        return scimJson({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          Resources: paged.map(({ user, identity, member }) =>
            serializeScimUser({
              id: user._id,
              user,
              externalId: identity?.externalId,
              location: `${state.url.origin}${state.url.pathname}/${user._id}`,
              active: identity?.active ?? member.status === "active",
            }),
          ),
          totalResults: filtered.length,
          startIndex: listRequest.startIndex,
          itemsPerPage: paged.length,
        });
      };

      const handleUsersPost: ScimHandler = async (state) => {
        const body = (await readScimJson(state.request)) as ScimBody;
        const extractedBase = extractScimProfile(state.scimConfig, body);
        const extracted =
          ((await config.connection?.hooks?.profileResolved?.({
            protocol: "scim",
            connectionId: state.connection._id,
            profile: extractedBase as Record<string, unknown>,
          })) as typeof extractedBase | undefined) ?? extractedBase;
        const provisionProfile =
          ((await config.connection?.hooks?.beforeProvision?.({
            protocol: "scim",
            connectionId: state.connection._id,
            profile: extracted as Record<string, unknown>,
          })) as typeof extracted | undefined) ?? extracted;
        const externalId = provisionProfile.externalId;
        // Provider under which this connection links SSO accounts. The SCIM
        // externalId is the providerAccountId, so (providerId, externalId) is
        // the Account's natural key — used both to resolve an already-
        // provisioned user below and to dedup the Account insert.
        const providerId =
          state.connection.protocol === "oidc"
            ? groupOidcProviderId(state.connection._id)
            : groupSamlProviderId(state.connection._id);
        const existingIdentity = externalId
          ? await getScimIdentity(state.ctx, config.component.connection, {
              connectionId: state.connection._id,
              resourceType: "user",
              externalId,
            })
          : null;
        // Resolve the already-provisioned user from the SCIM identity, falling
        // back to the linked Account when the identity row is absent. This
        // handler runs across several transactions (it is an action, not one
        // mutation), so a prior POST for the same externalId can have created
        // the User + Account but not yet written the identity; without this
        // fallback a retry would insert a SECOND User and a duplicate Account
        // sharing (providerId, externalId), and that duplicate makes
        // `account.get(...).unique()` throw on every future SSO login
        // (permanent lockout). Fully serializing a *simultaneous* double-POST
        // additionally needs a component-side resolve-or-create keyed on the
        // identity index — see selfAssessment.
        const linkedAccount =
          externalId && !existingIdentity?.userId
            ? ((await state.ctx.runQuery(config.component.account.get, {
                provider: providerId,
                providerAccountId: externalId,
              })) as { _id: string; userId: string } | null)
            : null;
        const resolvedUserId = existingIdentity?.userId ?? linkedAccount?.userId;
        const existingUser = resolvedUserId
          ? await auth.user.get(state.ctx, { id: resolvedUserId })
          : null;
        const created = existingUser === null;
        const provisionedRoleIds = resolveProvisionedRoleIds({
          policy: state.policy,
          groups: provisionProfile.groups,
          roles: provisionProfile.roles,
        });
        const userId = existingUser?._id
          ? existingUser._id
          : await insertUser(state.ctx, config.component.user, {
              name: provisionProfile.name,
              ...(typeof provisionProfile.firstName === "string"
                ? { firstName: provisionProfile.firstName }
                : {}),
              ...(typeof provisionProfile.lastName === "string"
                ? { lastName: provisionProfile.lastName }
                : {}),
              email: provisionProfile.email,
              ...(typeof provisionProfile.email === "string"
                ? { emailVerificationTime: Date.now() }
                : {}),
              phone: provisionProfile.phone,
              ...(typeof provisionProfile.phone === "string"
                ? { phoneVerificationTime: Date.now() }
                : {}),
              ...(provisionProfile.extend ? { extend: provisionProfile.extend } : {}),
            });
        if (created && externalId) {
          // New user: link the SSO Account, but only when one does not already
          // exist for (providerId, externalId). Re-checking immediately before
          // the insert dedups against a racing or retried POST so two Accounts
          // can never share the key and break `account.get(...).unique()` at
          // login.
          const priorAccount = (await state.ctx.runQuery(config.component.account.get, {
            provider: providerId,
            providerAccountId: externalId,
          })) as { _id: string } | null;
          if (priorAccount === null) {
            await insertAccount(state.ctx, config.component.account, {
              userId,
              provider: providerId,
              providerAccountId: externalId,
            });
          }
        }
        if (existingUser) {
          const nextUserData: Record<string, unknown> = {
            name: provisionProfile.name,
            firstName: provisionProfile.firstName,
            lastName: provisionProfile.lastName,
            email: provisionProfile.email,
            phone: provisionProfile.phone,
            ...(provisionProfile.extend ? { extend: provisionProfile.extend } : {}),
          };
          if (typeof provisionProfile.email === "string") {
            nextUserData.emailVerificationTime = Date.now();
          }
          if (typeof provisionProfile.phone === "string") {
            nextUserData.phoneVerificationTime = Date.now();
          }
          const patchData = applyUserProvisioningPatch({
            currentUser: existingUser as Record<string, unknown>,
            nextUser: nextUserData,
            policy: state.policy.provisioning.user,
            source: "scim",
          });
          if (Object.keys(patchData).length > 0) {
            await updateUser(state.ctx, config.component.user, {
              userId,
              patch: patchData,
            });
          }
        }
        const resolution = await auth.member.get(state.ctx, {
          groupId: state.connection.groupId,
          userId,
        });
        if (resolution.membership) {
          await auth.member.update(state.ctx, {
            id: resolution.membership._id,
            patch: { status: body.active === false ? "inactive" : "active" },
          });
        } else {
          await auth.member.create(state.ctx, {
            data: {
              groupId: state.connection.groupId,
              userId,
              roleIds: provisionedRoleIds,
              status: provisionProfile.active === false ? "inactive" : "active",
            },
          });
        }
        if (externalId) {
          await upsertScimIdentity(state.ctx, config.component.connection, {
            connectionId: state.connection._id,
            groupId: state.connection.groupId,
            resourceType: "user",
            externalId,
            userId,
            active: provisionProfile.active !== false,
            raw: body,
            lastProvisionedAt: Date.now(),
          });
        }
        await state.recordScimEvent(
          created ? "connection.scim.user.provisioned" : "connection.scim.user.updated",
          "success",
          { type: "user", id: userId },
        );
        const createdUser = await auth.user.get(state.ctx, { id: userId });
        await config.connection?.hooks?.afterProvision?.({
          protocol: "scim",
          connectionId: state.connection._id,
          profile: provisionProfile as Record<string, unknown>,
          userId,
        });
        const location = `${state.url.origin}${state.url.pathname}/${userId}`;
        return scimJson(
          serializeScimUser({
            id: userId,
            user: createdUser ?? {},
            externalId,
            location,
            active: provisionProfile.active !== false,
          }),
          created ? 201 : 200,
          { Location: location },
        );
      };

      const handleUsersUpsert: ScimHandler = async (state) => {
        const missing = requireScimResourceId(state.parsedPath.resourceId, "User");
        if (missing) return missing;
        const userId = state.parsedPath.resourceId!;
        const existingUser = await auth.user.get(state.ctx, { id: userId });
        if (!existingUser) {
          return scimError(404, "notFound", "User not found.");
        }
        const existingIdentity = await getScimIdentityByConnectionAndUser(
          state.ctx,
          config.component.connection,
          {
            connectionId: state.connection._id,
            userId,
          },
        );
        const existingMembership = await auth.member.get(state.ctx, {
          groupId: state.connection.groupId,
          userId,
        });
        if (!existingIdentity && !existingMembership.membership) {
          return scimError(404, "notFound", "User not found.");
        }
        const body = (await readScimJson(state.request)) as ScimBody;
        const extractedBase = extractScimProfile(state.scimConfig, body);
        const extracted =
          ((await config.connection?.hooks?.profileResolved?.({
            protocol: "scim",
            connectionId: state.connection._id,
            profile: extractedBase as Record<string, unknown>,
          })) as typeof extractedBase | undefined) ?? extractedBase;
        const provisionProfile =
          ((await config.connection?.hooks?.beforeProvision?.({
            protocol: "scim",
            connectionId: state.connection._id,
            profile: extracted as Record<string, unknown>,
          })) as typeof extracted | undefined) ?? extracted;
        const externalId = provisionProfile.externalId;
        const patchData: Record<string, unknown> = {};
        let nextActive: boolean | undefined;
        if (state.request.method === "PUT") {
          patchData.name = provisionProfile.name;
          patchData.firstName = provisionProfile.firstName;
          patchData.lastName = provisionProfile.lastName;
          patchData.email = provisionProfile.email;
          patchData.phone = provisionProfile.phone;
          if (provisionProfile.extend) {
            patchData.extend = provisionProfile.extend;
          }
          if (typeof patchData.email === "string") {
            patchData.emailVerificationTime = Date.now();
          }
          if (typeof patchData.phone === "string") {
            patchData.phoneVerificationTime = Date.now();
          }
        } else {
          const operations = Array.isArray(body.Operations)
            ? body.Operations
            : unsupportedScimPatch();
          for (const operation of operations) {
            const op = typeof operation.op === "string" ? operation.op.toLowerCase() : "replace";
            if (op !== "replace" && op !== "add") {
              unsupportedScimPatch();
            }
            if (
              operation.path === undefined &&
              typeof operation.value === "object" &&
              operation.value !== null
            ) {
              const value = operation.value as Record<string, unknown>;
              if (typeof value.active === "boolean") nextActive = value.active;
              if (typeof value.displayName === "string") patchData.name = value.displayName;
              if (typeof value.userName === "string") {
                patchData.email = value.userName;
                patchData.emailVerificationTime = Date.now();
              }
              continue;
            }
            if (operation.path === "active") {
              nextActive = typeof operation.value === "boolean" ? operation.value : undefined;
              continue;
            }
            if (operation.path === "displayName" || operation.path === "name.formatted") {
              patchData.name = operation.value;
              continue;
            }
            if (operation.path === "name.givenName") {
              patchData.firstName = operation.value;
              continue;
            }
            if (operation.path === "name.familyName") {
              patchData.lastName = operation.value;
              continue;
            }
            if (operation.path === "userName" || operation.path === "emails.value") {
              patchData.email = operation.value;
              if (typeof operation.value === "string") {
                patchData.emailVerificationTime = Date.now();
              }
              continue;
            }
            if (operation.path === "phoneNumbers.value") {
              patchData.phone = operation.value;
              if (typeof operation.value === "string") {
                patchData.phoneVerificationTime = Date.now();
              }
              continue;
            }
            unsupportedScimPatch();
          }
        }
        const nextPatchData = applyUserProvisioningPatch({
          currentUser: existingUser as Record<string, unknown>,
          nextUser: patchData,
          policy: state.policy.provisioning.user,
          source: "scim",
        });
        if (Object.keys(nextPatchData).length > 0) {
          await updateUser(state.ctx, config.component.user, {
            userId,
            patch: nextPatchData,
          });
        }
        const resolution = existingMembership;
        if (resolution.membership) {
          await auth.member.update(state.ctx, {
            id: resolution.membership._id,
            patch: {
              roleIds: resolveProvisionedRoleIds({
                policy: state.policy,
                groups: provisionProfile.groups,
                roles: provisionProfile.roles,
              }),
              status:
                provisionProfile.active === false || nextActive === false ? "inactive" : "active",
            },
          });
        }
        await upsertScimIdentity(state.ctx, config.component.connection, {
          connectionId: state.connection._id,
          groupId: state.connection.groupId,
          resourceType: "user",
          externalId: externalId ?? existingIdentity?.externalId ?? userId,
          userId,
          active: provisionProfile.active !== false && nextActive !== false,
          raw: body,
          lastProvisionedAt: Date.now(),
        });
        await state.recordScimEvent("connection.scim.user.updated", "success", {
          type: "user",
          id: userId,
        });
        const updatedUser = await auth.user.get(state.ctx, { id: userId });
        await config.connection?.hooks?.afterProvision?.({
          protocol: "scim",
          connectionId: state.connection._id,
          profile: provisionProfile as Record<string, unknown>,
          userId,
        });
        const location = `${state.url.origin}${state.url.pathname}`;
        return scimJson(
          serializeScimUser({
            id: userId,
            user: updatedUser ?? existingUser,
            externalId,
            location,
            active: provisionProfile.active !== false && nextActive !== false,
          }),
          200,
          { Location: location },
        );
      };

      const handleUsersDelete: ScimHandler = async (state) => {
        const missing = requireScimResourceId(state.parsedPath.resourceId, "User");
        if (missing) return missing;
        const userId = state.parsedPath.resourceId!;
        const identity = await getScimIdentityByConnectionAndUser(
          state.ctx,
          config.component.connection,
          {
            connectionId: state.connection._id,
            userId,
          },
        );
        if (!identity) {
          return scimError(404, "notFound", "User not found.");
        }
        const resolution = await auth.member.get(state.ctx, {
          groupId: state.connection.groupId,
          userId,
        });
        if (resolution.membership) {
          await auth.member.remove(state.ctx, { id: resolution.membership._id });
        }
        const { revoked } = (await state.ctx.runMutation(config.component.session.revokeForUser, {
          userId,
        })) as { revoked: number };
        if (revoked > 0) {
          await state.recordScimEvent(
            "session.invalidated",
            "success",
            { type: "user", id: userId },
            { userId, reason: "connection_deprovision" },
          );
        }
        if (state.policy.provisioning.deprovision.mode === "hard") {
          await removeScimIdentity(state.ctx, config.component.connection, identity._id);
        } else {
          await upsertScimIdentity(state.ctx, config.component.connection, {
            connectionId: identity.connectionId,
            groupId: identity.groupId,
            resourceType: identity.resourceType,
            externalId: identity.externalId,
            userId: identity.userId,
            mappedGroupId: identity.mappedGroupId,
            active: false,
            raw: identity.raw,
            lastProvisionedAt: Date.now(),
          });
        }
        await state.recordScimEvent("connection.scim.user.deactivated", "success", {
          type: "user",
          id: userId,
        });
        return new Response(null, { status: 204 });
      };

      const handleGroupsGet: ScimHandler = async (state) => {
        if (state.parsedPath.resourceId) {
          const groupId = state.parsedPath.resourceId;
          const group = (await auth.group.get(state.ctx, { id: groupId })) as GroupRecord | null;
          if (!group || group.parentGroupId !== state.connection.groupId) {
            return scimError(404, "notFound", "Group not found.");
          }
          const identity = await getScimIdentityByMappedGroup(
            state.ctx,
            config.component.connection,
            groupId,
          );
          const scopedIdentity =
            identity && identity.connectionId === state.connection._id ? identity : undefined;
          const members = (
            await collectMembers(state.ctx, { groupId: group._id, status: "active" })
          ).map((member) => ({ value: member.userId }));
          const location = `${state.url.origin}${state.url.pathname.replace(/\/[^/]+$/, "")}/${group._id}`;
          await state.recordScimEvent(
            "connection.scim.read",
            "success",
            { type: "group", id: group._id },
            { resourceType: "group", resourceId: group._id, operation: "get" },
          );
          return scimJson(
            serializeScimGroup({
              id: group._id,
              group,
              externalId: scopedIdentity?.externalId,
              location,
              members,
            }),
            200,
            { Location: location },
          );
        }
        const groupsList = {
          page: await collectGroups(state.ctx, { parentGroupId: state.connection.groupId }),
        };
        const identities = await listScimIdentitiesByConnection(
          state.ctx,
          config.component.connection,
          state.connection._id,
        );
        const identityByGroupId = new Map(
          identities
            .filter(
              (
                identity: ScimIdentityRecord,
              ): identity is ScimIdentityRecord & { mappedGroupId: string } =>
                typeof identity.mappedGroupId === "string",
            )
            .map((identity: ScimIdentityRecord & { mappedGroupId: string }) => [
              identity.mappedGroupId,
              identity,
            ]),
        );
        const groups: GroupListItem[] = await Promise.all(
          groupsList.page.map(async (group) => {
            const typedGroup = group as GroupRecord;
            const members = await collectMembers(state.ctx, {
              groupId: typedGroup._id,
              status: "active",
            });
            return {
              group: typedGroup,
              identity: identityByGroupId.get(typedGroup._id),
              memberIds: members.map((member) => member.userId),
            };
          }),
        );
        const listRequest = parseScimListRequest(state.url);
        const filtered = filterScimCollection<GroupListItem>(groups, listRequest.filter, {
          id: (item) => item.group._id,
          externalId: (item) => item.identity?.externalId,
          displayName: (item) => item.group.name,
          "members.value": (item) => item.memberIds,
        });
        const paged = paginateScimCollection(filtered, listRequest);
        await state.recordScimEvent(
          "connection.scim.read",
          "success",
          { type: "connection", id: state.connection._id },
          {
            resourceType: "group",
            operation: "list",
          },
        );
        return scimJson({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          Resources: paged.map(({ group, identity }) =>
            serializeScimGroup({
              id: group._id,
              group,
              externalId: identity?.externalId,
              location: `${state.url.origin}${state.url.pathname}/${group._id}`,
            }),
          ),
          totalResults: filtered.length,
          startIndex: listRequest.startIndex,
          itemsPerPage: paged.length,
        });
      };

      const handleGroupsPost: ScimHandler = async (state) => {
        const body = await readScimJson(state.request);
        const externalId = typeof body.externalId === "string" ? body.externalId : undefined;
        const existingIdentity = externalId
          ? await getScimIdentity(state.ctx, config.component.connection, {
              connectionId: state.connection._id,
              resourceType: "group",
              externalId,
            })
          : null;
        const existingGroup = existingIdentity?.mappedGroupId
          ? await auth.group.get(state.ctx, { id: existingIdentity.mappedGroupId })
          : null;
        const created = existingGroup === null;
        const provisionedRoleIds = resolveProvisionedRoleIds({
          policy: state.policy,
          groups: typeof body.displayName === "string" ? [body.displayName] : undefined,
          roles: pickStringArray((body as Record<string, unknown>).roles),
        });
        const groupId = existingGroup?._id
          ? existingGroup._id
          : await auth.group.create(state.ctx, {
              data: {
                name: typeof body.displayName === "string" ? body.displayName : "Group",
                parentGroupId: state.connection.groupId,
                type: "organization",
              },
            });
        if (!created && existingGroup) {
          const location = `${state.url.origin}${state.url.pathname}/${groupId}`;
          return scimJson(
            serializeScimGroup({
              id: groupId,
              group: existingGroup,
              externalId,
              location,
              members: (await collectMembers(state.ctx, { groupId, status: "active" })).map(
                (member) => ({ value: member.userId }),
              ),
            }),
            200,
            { Location: location },
          );
        }
        await upsertScimIdentity(state.ctx, config.component.connection, {
          connectionId: state.connection._id,
          groupId: state.connection.groupId,
          resourceType: "group",
          externalId: externalId ?? groupId,
          mappedGroupId: groupId,
          active: true,
          raw: body,
          lastProvisionedAt: Date.now(),
        });
        const currentMembers = await collectMembersForReplace(state.ctx, {
          groupId,
          status: "active",
        });
        const currentByUserId = new Map(currentMembers.map((member) => [member.userId, member]));
        const nextUserIds = new Set(
          (Array.isArray(body.members) ? body.members : []).map((member) => String(member.value)),
        );
        const toAddUserIds = [...nextUserIds].filter((userId) => !currentByUserId.has(userId));
        const invalidMember = await firstInvalidScimMember(state, toAddUserIds);
        if (invalidMember !== null) {
          return scimError(400, "invalidValue", `Group member user not found: ${invalidMember}`);
        }
        for (const member of currentMembers) {
          if (!nextUserIds.has(member.userId)) {
            await auth.member.remove(state.ctx, { id: member._id });
          }
        }
        for (const userId of toAddUserIds) {
          await auth.member.create(state.ctx, {
            data: {
              groupId,
              userId,
              roleIds: provisionedRoleIds,
              status: "active",
            },
          });
        }
        await state.recordScimEvent(
          created ? "connection.scim.group.provisioned" : "connection.scim.group.updated",
          "success",
          { type: "group", id: groupId },
        );
        const group = await auth.group.get(state.ctx, { id: groupId });
        const location = `${state.url.origin}${state.url.pathname}/${groupId}`;
        return scimJson(
          serializeScimGroup({
            id: groupId,
            group: group ?? {},
            externalId,
            location,
            members: (await collectMembers(state.ctx, { groupId, status: "active" })).map(
              (member) => ({ value: member.userId }),
            ),
          }),
          created ? 201 : 200,
          { Location: location },
        );
      };

      const handleGroupsPatch: ScimHandler = async (state) => {
        const missing = requireScimResourceId(state.parsedPath.resourceId, "Group");
        if (missing) return missing;
        const groupId = state.parsedPath.resourceId!;
        const identity = await getScimIdentityByMappedGroup(
          state.ctx,
          config.component.connection,
          groupId,
        );
        if (!identity || identity.connectionId !== state.connection._id) {
          return scimError(404, "notFound", "Group not found.");
        }
        const body = (await readScimJson(state.request)) as ScimBody;
        const operations = Array.isArray(body.Operations)
          ? body.Operations
          : unsupportedScimPatch();
        for (const operation of operations) {
          const op = typeof operation.op === "string" ? operation.op.toLowerCase() : "replace";
          if (
            operation.path === undefined &&
            op === "replace" &&
            typeof operation.value === "object" &&
            operation.value !== null
          ) {
            const value = operation.value as Record<string, unknown>;
            if (typeof value.displayName === "string") {
              await auth.group.update(state.ctx, {
                id: groupId,
                patch: { name: value.displayName },
              });
            }
            continue;
          }
          if (operation.path === "displayName") {
            if (op !== "replace" && op !== "add") unsupportedScimPatch();
            await auth.group.update(state.ctx, {
              id: groupId,
              patch: { name: operation.value },
            });
            continue;
          }
          if (operation.path === "members" && op === "add") {
            const addUserIds = (Array.isArray(operation.value) ? operation.value : []).map(
              (member) => String(member.value),
            );
            const invalidMember = await firstInvalidScimMember(state, addUserIds);
            if (invalidMember !== null) {
              return scimError(
                400,
                "invalidValue",
                `Group member user not found: ${invalidMember}`,
              );
            }
            for (const userId of addUserIds) {
              const existing = await auth.member.get(state.ctx, { groupId, userId });
              if (!existing.membership) {
                await auth.member.create(state.ctx, {
                  data: {
                    groupId,
                    userId,
                    roleIds: resolveProvisionedRoleIds({
                      policy: state.policy,
                      groups: typeof body.displayName === "string" ? [body.displayName] : undefined,
                      roles: pickStringArray((body as Record<string, unknown>).roles),
                    }),
                    status: "active",
                  },
                });
              }
            }
            continue;
          }
          if (operation.path === "members" && op === "replace") {
            const currentMembers = await collectMembersForReplace(state.ctx, {
              groupId,
              status: "active",
            });
            const currentUserIds = new Set<string>(currentMembers.map((member) => member.userId));
            const nextUserIds = new Set<string>(
              (Array.isArray(operation.value) ? operation.value : []).map((member: unknown) =>
                String((member as { value?: unknown }).value),
              ),
            );
            const toAddUserIds = [...nextUserIds].filter((userId) => !currentUserIds.has(userId));
            const invalidMember = await firstInvalidScimMember(state, toAddUserIds);
            if (invalidMember !== null) {
              return scimError(
                400,
                "invalidValue",
                `Group member user not found: ${invalidMember}`,
              );
            }
            for (const member of currentMembers) {
              if (!nextUserIds.has(member.userId)) {
                await auth.member.remove(state.ctx, { id: member._id });
              }
            }
            for (const userId of toAddUserIds) {
              await auth.member.create(state.ctx, {
                data: {
                  groupId,
                  userId,
                  roleIds: resolveProvisionedRoleIds({
                    policy: state.policy,
                    groups: typeof body.displayName === "string" ? [body.displayName] : undefined,
                    roles: pickStringArray((body as Record<string, unknown>).roles),
                  }),
                  status: "active",
                },
              });
            }
            continue;
          }
          if (
            typeof operation.path === "string" &&
            op === "remove" &&
            operation.path.startsWith("members[")
          ) {
            const match = operation.path.match(/^members\[value eq "([^"]+)"\]$/);
            const userId = match?.[1];
            if (userId) {
              const resolution = await auth.member.get(state.ctx, {
                groupId,
                userId,
              });
              if (resolution.membership) {
                await auth.member.remove(state.ctx, { id: resolution.membership._id });
              }
            }
            continue;
          }
          unsupportedScimPatch();
        }
        await state.recordScimEvent("connection.scim.group.updated", "success", {
          type: "group",
          id: groupId,
        });
        const group = await auth.group.get(state.ctx, { id: groupId });
        const location = `${state.url.origin}${state.url.pathname}`;
        const members = await collectMembers(state.ctx, { groupId, status: "active" });
        return scimJson(
          serializeScimGroup({
            id: groupId,
            group: group ?? {},
            location,
            members: members.map((member) => ({
              value: member.userId,
            })),
          }),
          200,
          { Location: location },
        );
      };

      const handleGroupsDelete: ScimHandler = async (state) => {
        const missing = requireScimResourceId(state.parsedPath.resourceId, "Group");
        if (missing) return missing;
        const groupId = state.parsedPath.resourceId!;
        const identity = await getScimIdentityByMappedGroup(
          state.ctx,
          config.component.connection,
          groupId,
        );
        if (!identity || identity.connectionId !== state.connection._id) {
          return scimError(404, "notFound", "Group not found.");
        }
        await auth.group.remove(state.ctx, { id: groupId });
        await removeScimIdentity(state.ctx, config.component.connection, identity._id);
        await state.recordScimEvent("connection.scim.group.deactivated", "success", {
          type: "group",
          id: groupId,
        });
        return new Response(null, { status: 204 });
      };

      const scimHandlers: Record<string, Partial<Record<string, ScimHandler>>> = {
        ServiceProviderConfig: {
          GET: async () =>
            scimJson({
              schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
              patch: { supported: true },
              bulk: {
                supported: false,
                maxOperations: 0,
                maxPayloadSize: 0,
              },
              filter: { supported: true, maxResults: 100 },
              changePassword: { supported: false },
              sort: { supported: false },
              etag: { supported: false },
              authenticationSchemes: [
                {
                  type: "oauthbearertoken",
                  name: "Bearer Token",
                  description: "Use the SCIM token generated by Convex Auth connection.",
                },
              ],
            }),
        },
        Schemas: {
          GET: async (state) =>
            handleStaticScimCollection(SCIM_SCHEMAS, state.parsedPath.resourceId, {
              by: "id",
              notFound: "Schema not found.",
            }),
        },
        ResourceTypes: {
          GET: async (state) =>
            handleStaticScimCollection(SCIM_RESOURCE_TYPES, state.parsedPath.resourceId, {
              by: "name",
              notFound: "Resource type not found.",
            }),
        },
        Users: {
          GET: handleUsersGet,
          POST: handleUsersPost,
          PATCH: handleUsersUpsert,
          PUT: handleUsersUpsert,
          DELETE: handleUsersDelete,
        },
        Groups: {
          GET: handleGroupsGet,
          POST: handleGroupsPost,
          PATCH: handleGroupsPatch,
          DELETE: handleGroupsDelete,
        },
      };

      const handler = scimHandlers[state.parsedPath.resource]?.[state.request.method];
      return handler
        ? await handler(state)
        : scimError(404, "notFound", "SCIM resource not found.");
    } catch (error) {
      if (error instanceof Error && error.message === "Unsupported SCIM filter.") {
        return scimError(400, "invalidFilter", error.message);
      }
      if (error instanceof Error && error.message === "Invalid SCIM pagination.") {
        return scimError(400, "invalidValue", error.message);
      }
      if (error instanceof Error && error.message === "Invalid SCIM JSON.") {
        return scimError(400, "invalidSyntax", error.message);
      }
      if (error instanceof Error && error.message === "Unsupported SCIM content type.") {
        return scimError(415, "invalidSyntax", error.message);
      }
      if (error instanceof Error && error.message === "Unsupported SCIM PATCH operation.") {
        return scimError(400, "invalidSyntax", error.message);
      }
      if (error instanceof Error && error.message === "SCIM member set too large to reconcile.") {
        return scimError(413, "tooLarge", error.message);
      }
      if (
        error instanceof ConvexError &&
        typeof error.data === "object" &&
        error.data !== null &&
        "code" in error.data &&
        "message" in error.data
      ) {
        const code = error.data.code as string;
        const status = code === "MISSING_BEARER_TOKEN" || code === "INVALID_API_KEY" ? 401 : 400;
        const response = scimError(
          status,
          status === 401 ? "invalidValue" : code,
          error.data.message,
        );
        if (status === 401) {
          response.headers.set("WWW-Authenticate", "Bearer");
        }
        return response;
      }
      log("WARN", "[connection.scim] unhandled error surfaced as SCIM 500", {
        error: error instanceof Error ? error.message : String(error),
      });
      return scimError(500, "internalError", "SCIM request failed.");
    }
  };

  const handleOidcCallbackForConnection = async (
    ctx: GenericActionCtx<GenericDataModel>,
    request: Request,
    connectionId: string,
  ) => {
    const params = await getOidcCallbackParams(request);
    const { connection, oidc } = await loadConnectionOidcOrThrow(ctx, connectionId);
    const { providerId, provider, oauthConfig } = await createGroupConnectionOidcRuntime({
      ctx,
      componentConnection: config.component.connection,
      rootUrl: requireEnv("CONVEX_SITE_URL"),
      connectionId: connection._id,
      oidc,
      sharedRedirectURI: sharedOidcRedirectURI,
    });
    const cookies = getCookies(request);
    const maybeRedirectTo = useRedirectToParam(providerId, cookies);
    const destinationUrl = await redirectAbsoluteUrl(ctx, config, {
      redirectTo: maybeRedirectTo?.redirectTo,
    });
    let result: Awaited<ReturnType<typeof handleOAuthCallback>>;
    try {
      result = await handleOAuthCallback(
        providerId,
        { ...oauthConfig, provider },
        Object.fromEntries(params.entries()),
        cookies,
      );
    } catch (error) {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "oidc",
        outcome: "failure",
        error,
      });
      throw error;
    }
    const extraFields =
      typeof oidc.profile === "object" && oidc.profile !== null
        ? ((oidc.profile as Record<string, unknown>).extraFields as
            | Record<string, string>
            | undefined)
        : undefined;
    let profile = result.profile as Record<string, unknown>;
    if (extraFields && typeof profile === "object" && profile) {
      const extend: Record<string, unknown> = {};
      for (const [claimName, fieldName] of Object.entries(extraFields)) {
        if (claimName in profile) {
          extend[fieldName] = profile[claimName];
        }
      }
      if (Object.keys(extend).length > 0) {
        profile = { ...profile, extend };
      }
    }

    let verificationCode: string;
    try {
      verificationCode = await callUserOAuth(ctx, {
        provider: providerId,
        providerAccountId: result.providerAccountId,
        profile: profile as AuthProfile,
        signature: result.signature,
        accountExtend: {
          identity: {
            protocol: "oidc",
            connectionId: connection._id,
            subject: result.providerAccountId,
            issuer:
              typeof (oidc.discovery as Record<string, unknown> | undefined)?.issuer === "string"
                ? ((oidc.discovery as Record<string, unknown>).issuer as string)
                : undefined,
            discoveryUrl:
              typeof (oidc.discovery as Record<string, unknown> | undefined)?.discoveryUrl ===
              "string"
                ? ((oidc.discovery as Record<string, unknown>).discoveryUrl as string)
                : undefined,
          },
        },
      });
    } catch (error) {
      await recordConnectionLoginEvent(ctx, {
        connection,
        protocol: "oidc",
        outcome: "failure",
        error,
      });
      throw error;
    }
    await recordConnectionLoginEvent(ctx, {
      connection,
      protocol: "oidc",
      outcome: "success",
    });
    const headers = new Headers({
      Location: setURLSearchParam(destinationUrl, "code", verificationCode),
    });
    for (const { name, value, options } of result.cookies) {
      headers.append("Set-Cookie", serializeCookie(name, value, options));
    }
    if (maybeRedirectTo) {
      headers.append(
        "Set-Cookie",
        serializeCookie(
          maybeRedirectTo.updatedCookie.name,
          maybeRedirectTo.updatedCookie.value,
          maybeRedirectTo.updatedCookie.options,
        ),
      );
    }
    return new Response(null, { status: 302, headers });
  };

  addConnectionRoutes(http, {
    routeBase: GROUP_CONNECTION_ROUTE_BASE,
    convertErrorsToResponse,
    handleSamlMetadata: async (ctx, _request, runtimeRoute) => {
      const { loaded } = await loadActiveConnectionSamlOrThrow(ctx, runtimeRoute.connectionId);
      return new Response(
        createGroupConnectionSamlMetadataXml({
          rootUrl: requireEnv("CONVEX_SITE_URL"),
          source: loaded.source,
          config: loaded.config,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        },
      );
    },
    handleSamlSignIn: async (ctx, request, runtimeRoute) => {
      const url = new URL(request.url);
      const verifier = url.searchParams.get("code");
      if (!verifier) {
        throw convexError(ErrorCode.OAUTH_MISSING_VERIFIER, "Missing sign-in verifier.");
      }
      const { loaded, connection } = await loadActiveConnectionSamlOrThrow(
        ctx,
        runtimeRoute.connectionId,
      );
      const state = generateRandomString(24, INVITE_TOKEN_ALPHABET);
      const signInRequest = await createGroupConnectionSamlSignInRequest({
        rootUrl: requireEnv("CONVEX_SITE_URL"),
        source: { kind: "connection", id: connection._id },
        config: loaded.config,
        state,
        signature: `saml ${connection._id} pending ${state}`,
        redirectTo: url.searchParams.get("redirectTo") ?? undefined,
      });
      const signature = `saml ${connection._id} ${signInRequest.requestId} ${state}`;
      await callVerifierSignature(ctx, { verifier, signature });
      const nowMs = Date.now();
      await ctx.runMutation(config.component.connection.saml.request.create, {
        connectionId: connection._id,
        requestId: signInRequest.requestId,
        createdAt: nowMs,
        expiresAt: nowMs + SAML_LOGIN_REQUEST_TTL_MS,
      });
      const redirectTo = url.searchParams.get("redirectTo");
      const redirectCookies =
        redirectTo !== null
          ? [redirectToParamCookie(groupSamlProviderId(connection._id), redirectTo)]
          : [];
      const relayState = encodeGroupSamlRelayState({
        source: { kind: "connection", id: connection._id },
        signature,
        requestId: signInRequest.requestId,
        state,
        redirectTo: url.searchParams.get("redirectTo") ?? undefined,
      });
      if (signInRequest.binding === "redirect" && signInRequest.redirectUrl) {
        const redirectUrl = new URL(signInRequest.redirectUrl);
        redirectUrl.searchParams.set("RelayState", relayState);
        const headers = new Headers({
          Location: redirectUrl.toString(),
        });
        for (const { name, value, options } of redirectCookies as CookieToSerialize[]) {
          headers.append("Set-Cookie", serializeCookie(name, value, options));
        }
        return new Response(null, { status: 302, headers });
      }
      const response = createSamlPostBindingResponse({
        endpoint: signInRequest.post!.endpoint,
        parameter: "SAMLRequest",
        value: signInRequest.post!.value,
        relayState,
      });
      for (const { name, value, options } of redirectCookies as CookieToSerialize[]) {
        response.headers.append("Set-Cookie", serializeCookie(name, value, options));
      }
      return response;
    },
    handleOidcSignIn: async (ctx, request, runtimeRoute) => {
      const url = new URL(request.url);
      const verifier = url.searchParams.get("code");
      if (!verifier) {
        throw convexError(ErrorCode.OAUTH_MISSING_VERIFIER, "Missing sign-in verifier.");
      }
      const { connection, oidc } = await loadConnectionOidcOrThrow(ctx, runtimeRoute.connectionId);
      const { providerId, provider, oauthConfig } = await createGroupConnectionOidcRuntime({
        ctx,
        componentConnection: config.component.connection,
        rootUrl: requireEnv("CONVEX_SITE_URL"),
        connectionId: connection._id,
        oidc,
        sharedRedirectURI: sharedOidcRedirectURI,
      });
      const { redirect, cookies, signature } = await createOAuthAuthorizationURL(
        providerId,
        {
          ...oauthConfig,
          provider,
        },
        {
          loginHint:
            url.searchParams.get("loginHint") ??
            (typeof (oidc.request as Record<string, unknown> | undefined)?.loginHint === "string"
              ? ((oidc.request as Record<string, unknown>).loginHint as string)
              : undefined),
          stateTransform:
            typeof sharedOidcRedirectURI === "string"
              ? (state) =>
                  encodeGroupOidcState({
                    connectionId: connection._id,
                    state,
                  })
              : undefined,
        },
      );
      await callVerifierSignature(ctx, { verifier, signature });
      const redirectTo = url.searchParams.get("redirectTo");
      const headers_ = new Headers({ Location: redirect });
      for (const { name, value, options } of [
        ...cookies,
        ...(redirectTo !== null ? [redirectToParamCookie(providerId, redirectTo)] : []),
      ] as CookieToSerialize[]) {
        headers_.append("Set-Cookie", serializeCookie(name, value, options));
      }
      return new Response(null, {
        status: 302,
        headers: headers_,
      });
    },
    handleOidcCallback: async (ctx, request, runtimeRoute) => {
      return await handleOidcCallbackForConnection(ctx, request, runtimeRoute.connectionId);
    },
    handleSamlAcs,
    handleSamlSlo,
    handleScimRequest,
    sharedOidcCallbackPath: sharedOidcRedirectURI,
    handleOidcSharedCallback: async (ctx, request) => {
      const url = new URL(request.url);
      const params = await getOidcCallbackParams(request);
      const { connectionId } = decodeGroupOidcState(params.get("state"));
      url.search = params.toString();
      const normalizedRequest = new Request(url, request);
      return await handleOidcCallbackForConnection(ctx, normalizedRequest, connectionId);
    },
    scimError,
  });
}
