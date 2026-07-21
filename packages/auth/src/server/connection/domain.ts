import type { GenericActionCtx, GenericDataModel } from "convex/server";

import { ErrorCode } from "../../shared/codes";
import { assertSafeIdpFetchUrl } from "../../shared/fetch/guard";
import { convexError } from "../errors";
import type { ComponentActionCtx, ComponentCtx, ComponentReadCtx } from "../component/context";
import { retryWithBackoff } from "../utils/retry";

import {
  createConnectionDomain,
  createGroupConnection,
  removeConnectionDomain,
  removeConnectionDomainVerification,
  getConnectionDomainVerification,
  getGroupConnection,
  getGroupConnectionByDomain,
  getScimConfigByConnection,
  listGroupConnections,
  listConnectionDomains,
  removeGroupConnection,
  updateGroupConnection,
  upsertConnectionDomainVerification,
  upsertGroupConnectionSecret,
  verifyConnectionDomain,
} from "../contract";
import { log } from "../log";
import type { EmitGroupAuthEventInput } from "./group/service";
import type {
  ConvexAuthMaterializedConfig,
  OIDCClaimMapping,
  GroupConnectionPolicy,
} from "../types";
import {
  getOidcConfig,
  getPublicConnectionConfig,
  getPublicOidcConfig,
  getPublicSamlConfig,
  getSamlConfig,
  upsertProtocolConfig,
  withOidcSecretState,
} from "./config";
import { createGroupPolicyDomain } from "./policy/domain";
import { createGroupScimDomain } from "./provision";
import {
  createServiceProviderMetadata,
  parseSamlIdpMetadataChecked,
  getSamlServiceProviderOptions,
} from "./saml";
import type { EncryptedSecret } from "../../shared/brand";
import type { SamlConfigShape } from "./saml";
import {
  getGroupOidcUrls,
  getGroupSamlUrls,
  groupOidcProviderId,
  groupSamlProviderId,
  normalizeDomain,
} from "./shared";
import { createGroupWebhookDomain } from "./webhook";

type DomainDeps = {
  config: ConvexAuthMaterializedConfig & { extraProviders?: unknown[] };
  connectionNotFoundError: string;
  GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND: "oidc_client_secret";
  requireEnv: (name: string) => string;
  generateRandomString: (length: number, alphabet: string) => string;
  INVITE_TOKEN_ALPHABET: string;
  sha256: (input: string) => Promise<string>;
  encryptSecret: (value: string) => Promise<EncryptedSecret>;
  sharedOidcRedirectURI?: string;
  getGroupConnectionSecret: (
    ctx: ComponentReadCtx,
    connectionId: string,
    kind: "oidc_client_secret",
  ) => Promise<Record<string, unknown> | null>;
  loadConnectionOrThrow: (
    ctx: ComponentReadCtx,
    connectionId: string,
  ) => Promise<{
    _id: string;
    groupId: string;
    protocol: "oidc" | "saml";
    status: "draft" | "active" | "disabled";
    config?: unknown;
  }>;
  validateGroupConnectionPolicy: (
    policy: GroupConnectionPolicy,
  ) => Array<{ name: string; ok: boolean; message?: string }>;
  emitGroupAuthEvent: (ctx: ComponentCtx, data: EmitGroupAuthEventInput) => Promise<string>;
  loadGroupPolicyOrThrow: (
    ctx: ComponentReadCtx,
    groupId: string,
  ) => Promise<GroupConnectionPolicy>;
};

/**
 * Build the connection and Connection management domain.
 */
export function createGroupConnectionDomain<TDeps extends DomainDeps>(deps: TDeps) {
  const {
    config,
    getGroupConnectionSecret,
    loadConnectionOrThrow,
    validateGroupConnectionPolicy,
    emitGroupAuthEvent,
    connectionNotFoundError,
    GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
    requireEnv,
    generateRandomString,
    INVITE_TOKEN_ALPHABET,
    sha256,
    encryptSecret,
    loadGroupPolicyOrThrow,
  } = deps;

  const webhook = createGroupWebhookDomain({
    config,
    encryptSecret,
    loadConnectionOrThrow,
    emitGroupAuthEvent,
  });
  const scim = createGroupScimDomain({
    config,
    requireEnv,
    generateRandomString,
    INVITE_TOKEN_ALPHABET,
    sha256,
    loadGroupPolicyOrThrow,
    emitGroupAuthEvent,
  });
  const policy = createGroupPolicyDomain({
    config,
    loadGroupPolicyOrThrow,
    validateGroupConnectionPolicy,
    emitGroupAuthEvent,
  });

  const resolveGroupConnectionProtocol = (connection: {
    _id: string;
    protocol?: unknown;
    config?: unknown;
  }): "oidc" | "saml" => {
    if (connection.protocol === "oidc") {
      return "oidc";
    }
    if (connection.protocol === "saml") {
      return "saml";
    }
    throw convexError(
      ErrorCode.PROVIDER_NOT_CONFIGURED,
      "Group connection protocol is not configured.",
    );
  };

  const GROUP_CONNECTION_DOMAIN_VERIFICATION_PREFIX = "_convex-auth-verification";
  const GROUP_CONNECTION_DOMAIN_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

  const toDomainSummary = (domain: {
    _id: string;
    domain: string;
    isPrimary: boolean;
    verifiedAt?: number;
  }) => ({
    domainId: domain._id,
    domain: domain.domain,
    isPrimary: domain.isPrimary,
    verified: domain.verifiedAt !== undefined,
    verifiedAt: domain.verifiedAt ?? null,
  });

  const getDomainVerificationRecordName = (domain: string) =>
    `${GROUP_CONNECTION_DOMAIN_VERIFICATION_PREFIX}.${normalizeDomain(domain)}`;

  const parseTxtAnswer = (value: string) => {
    const quoted = [...value.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    if (quoted.length > 0) {
      return quoted.join("");
    }
    return value.replace(/^"|"$/g, "").trim();
  };

  const resolveTxtValues = async (recordName: string) => {
    const url = new URL("https://dns.google/resolve");
    url.searchParams.set("name", recordName);
    url.searchParams.set("type", "TXT");

    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`DNS TXT lookup failed with status ${response.status}.`);
    }
    const data = (await response.json()) as {
      Answer?: Array<{ name?: string; type?: number; data?: string }>;
    };
    const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();
    const expectedName = normalizeName(recordName);
    return (data.Answer ?? [])
      .filter(
        (answer) =>
          answer.type === 16 &&
          typeof answer.name === "string" &&
          normalizeName(answer.name) === expectedName,
      )
      .map((answer) => (typeof answer.data === "string" ? parseTxtAnswer(answer.data) : null))
      .filter((value): value is string => value !== null && value.length > 0);
  };

  async function getConnection(
    ctx: ComponentReadCtx,
    args: { id: string },
  ): Promise<Awaited<ReturnType<typeof getGroupConnection>>>;
  async function getConnection(
    ctx: ComponentReadCtx,
    args: { domain: string },
  ): Promise<Awaited<ReturnType<typeof getGroupConnectionByDomain>>>;
  async function getConnection(
    ctx: ComponentReadCtx,
    args: { id?: string; domain?: string },
  ): Promise<
    | Awaited<ReturnType<typeof getGroupConnection>>
    | Awaited<ReturnType<typeof getGroupConnectionByDomain>>
  > {
    if (args.id !== undefined) {
      const record = await getGroupConnection(ctx, config.component.connection, args.id);
      return record === null
        ? null
        : { ...record, config: getPublicConnectionConfig(record.config) };
    }
    if (args.domain !== undefined) {
      const lookup = await getGroupConnectionByDomain(
        ctx,
        config.component.connection,
        normalizeDomain(args.domain),
      );
      if (lookup === null || lookup.connection === null) return lookup;
      return {
        ...lookup,
        connection: {
          ...lookup.connection,
          config: getPublicConnectionConfig(lookup.connection.config),
        },
      };
    }
    throw convexError(ErrorCode.INVALID_PARAMETERS, "Connection id or domain is required.");
  }

  return {
    connection: {
      create: async (
        ctx: ComponentCtx,
        data: {
          groupId: string;
          protocol: "oidc" | "saml";
          slug?: string;
          name?: string;
          status?: "draft" | "active" | "disabled";
          config?: Record<string, unknown>;
          extend?: Record<string, unknown>;
        },
      ): Promise<{ connectionId: string; groupId: string }> => {
        const connectionId = await createGroupConnection(ctx, config.component.connection, data);
        await emitGroupAuthEvent(ctx, {
          connectionId,
          groupId: data.groupId,
          kind: "connection.created",
          actor: { type: "system" },
          subject: { type: "connection", id: connectionId },
          outcome: "success",
          data: { connectionId, protocol: data.protocol },
          webhook: false,
        });
        return {
          connectionId,
          groupId: data.groupId,
        };
      },
      get: getConnection,
      list: async (
        ctx: ComponentReadCtx,
        opts: {
          where?: {
            groupId?: string;
            slug?: string;
            status?: "draft" | "active" | "disabled";
          };
          paginationOpts: { numItems: number; cursor: string | null };
          orderBy?: "_creationTime" | "name" | "slug" | "status";
          order?: "asc" | "desc";
        },
      ) => {
        const result = await listGroupConnections(ctx, config.component.connection, {
          where: opts.where,
          paginationOpts: opts.paginationOpts,
          orderBy: opts.orderBy,
          order: opts.order,
        });
        return {
          ...result,
          page: result.page.map((record) => ({
            ...record,
            config: getPublicConnectionConfig(record.config),
          })),
        };
      },
      update: async (ctx: ComponentCtx, args: { id: string; patch: Record<string, unknown> }) => {
        await updateGroupConnection(ctx, config.component.connection, {
          connectionId: args.id,
          patch: args.patch,
        });
        const updated = await getConnection(ctx, { id: args.id });
        if (updated !== null) {
          await emitGroupAuthEvent(ctx, {
            connectionId: args.id,
            groupId: updated.groupId,
            kind: "connection.updated",
            actor: { type: "system" },
            subject: { type: "connection", id: args.id },
            outcome: "success",
            data: { connectionId: args.id, changed: Object.keys(args.patch) },
            webhook: false,
          });
        }
        return { connectionId: args.id };
      },
      remove: async (ctx: ComponentCtx, args: { id: string }) => {
        const connection = await getConnection(ctx, { id: args.id });
        await removeGroupConnection(ctx, config.component.connection, args.id);
        if (connection !== null) {
          await emitGroupAuthEvent(ctx, {
            connectionId: args.id,
            groupId: connection.groupId,
            kind: "connection.removed",
            actor: { type: "system" },
            subject: { type: "connection", id: args.id },
            outcome: "success",
            data: { connectionId: args.id },
            webhook: false,
          });
        }
        return { connectionId: args.id };
      },
      /**
       * Aggregate readiness status across all configured protocols for an
       * group connection.
       *
       * Returns a structured result indicating whether the connection is
       * ready, with per-protocol checks so callers can surface actionable
       * diagnostics without running full network validation.
       */
      status: async (ctx: ComponentReadCtx, args: { id: string }) => {
        const connectionId = args.id;
        const connection = await getGroupConnection(ctx, config.component.connection, connectionId);
        if (!connection) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }
        const policy = await loadGroupPolicyOrThrow(ctx, connection.groupId);
        const oidcConfig = getOidcConfig(connection.config);
        const oidcSecret = await getGroupConnectionSecret(
          ctx,
          connection._id,
          GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
        );
        const samlConfig = getSamlConfig(connection.config);
        const scimConfig = await getScimConfigByConnection(
          ctx,
          config.component.connection,
          connectionId,
        );
        const domains = await listConnectionDomains(ctx, config.component.connection, connectionId);

        const oidcReady =
          oidcConfig?.enabled === true &&
          typeof oidcConfig?.client?.id === "string" &&
          oidcConfig.client.id.length > 0 &&
          oidcSecret !== null &&
          (typeof oidcConfig?.discovery?.issuer === "string" ||
            typeof oidcConfig?.discovery?.discoveryUrl === "string");
        const samlReady =
          samlConfig?.enabled === true && typeof samlConfig?.idp?.entityId === "string";
        const scimReady = scimConfig?.status === "active";

        const ready =
          connection.status === "active" &&
          (connection.protocol === "oidc" ? oidcReady : samlReady);

        return {
          connectionId: connection._id,
          status: connection.status,
          ready,
          domainCount: (domains as unknown[]).length,
          protocols: {
            oidc: {
              configured: connection.protocol === "oidc" ? oidcReady : false,
              ready: connection.protocol === "oidc" ? oidcReady : false,
              clientId: oidcConfig?.client?.id ?? null,
              issuer: oidcConfig?.discovery?.issuer ?? oidcConfig?.discovery?.discoveryUrl ?? null,
            },
            saml: {
              configured: connection.protocol === "saml" ? samlReady : false,
              ready: connection.protocol === "saml" ? samlReady : false,
              entityId: samlConfig?.idp?.entityId ?? samlConfig?.idp?.issuer ?? null,
            },
            scim: {
              configured: scimReady,
              ready: scimReady,
              basePath: scimConfig?.basePath ?? null,
              deprovisionMode: policy.provisioning.deprovision.mode,
            },
          },
        };
      },
    },
    domain: {
      create: async (
        ctx: ComponentCtx,
        data: {
          connectionId: string;
          groupId: string;
          domain: string;
          isPrimary?: boolean;
        },
      ): Promise<string> => {
        return await createConnectionDomain(ctx, config.component.connection, {
          ...data,
          domain: normalizeDomain(data.domain),
        });
      },
      list: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        return await listConnectionDomains(ctx, config.component.connection, args.connectionId);
      },
      validate: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        const connection = await getGroupConnection(ctx, config.component.connection, connectionId);
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }

        const domains = await listConnectionDomains(ctx, config.component.connection, connectionId);
        const primaryDomains = domains.filter(
          (domain: (typeof domains)[number]) => domain.isPrimary,
        );
        const verifiedDomains = domains.filter(
          (domain: (typeof domains)[number]) => domain.verifiedAt !== undefined,
        );

        const warnings: string[] = [];
        if (domains.length === 0) {
          warnings.push("No domains configured.");
        }
        if (primaryDomains.length === 0 && domains.length > 0) {
          warnings.push("No primary domain configured.");
        }
        if (primaryDomains.length > 1) {
          warnings.push("Multiple primary domains configured.");
        }
        if (verifiedDomains.length === 0 && domains.length > 0) {
          warnings.push("No verified domains yet.");
        }

        return {
          connectionId,
          ready:
            connection.status === "active" &&
            domains.length > 0 &&
            primaryDomains.length === 1 &&
            verifiedDomains.length > 0,
          summary: {
            domainCount: domains.length,
            primaryCount: primaryDomains.length,
            verifiedCount: verifiedDomains.length,
          },
          domains: domains.map((domain: (typeof domains)[number]) => toDomainSummary(domain)),
          warnings,
        };
      },
      status: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        const [connection, domains] = await Promise.all([
          getGroupConnection(ctx, config.component.connection, connectionId),
          listConnectionDomains(ctx, config.component.connection, connectionId),
        ]);
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }
        const primaryDomain =
          domains.find((domain: (typeof domains)[number]) => domain.isPrimary) ?? null;
        const verifiedDomains = domains.filter(
          (domain: (typeof domains)[number]) => domain.verifiedAt !== undefined,
        );
        const pendingChallenges = (
          await Promise.all(
            domains.map(async (domain: (typeof domains)[number]) => {
              const verification = await getConnectionDomainVerification(
                ctx,
                config.component.connection,
                domain._id,
              );
              if (!verification || verification.expiresAt < Date.now()) {
                return null;
              }
              return {
                domain: domain.domain,
                recordName: verification.recordName,
                expiresAt: verification.expiresAt,
              };
            }),
          )
        ).filter((challenge): challenge is NonNullable<typeof challenge> => challenge !== null);

        const warnings: string[] = [];
        const nextSteps: string[] = [];
        if (domains.length === 0) {
          warnings.push("No domains configured.");
          nextSteps.push("Attach at least one domain to this connection.");
        }
        if (primaryDomain === null && domains.length > 0) {
          warnings.push("No primary domain configured.");
          nextSteps.push("Mark one attached domain as the primary domain.");
        }
        if (verifiedDomains.length === 0 && domains.length > 0) {
          warnings.push("No verified domains yet.");
          nextSteps.push(
            "Request a TXT challenge and confirm verification for at least one domain.",
          );
        }
        if (
          primaryDomain !== null &&
          primaryDomain.verifiedAt === undefined &&
          domains.length > 0
        ) {
          nextSteps.push(
            `Verify the primary domain ${primaryDomain.domain} to establish trusted ownership.`,
          );
        }
        if (pendingChallenges.length > 0) {
          nextSteps.push(
            "If DNS is already updated, confirm the pending TXT challenge to complete verification.",
          );
        }

        const primaryDomainVerified = primaryDomain?.verifiedAt !== undefined;

        return {
          connectionId,
          ready:
            connection.status === "active" &&
            domains.length > 0 &&
            primaryDomain !== null &&
            verifiedDomains.length > 0,
          primaryDomain:
            primaryDomain === null
              ? null
              : {
                  domainId: primaryDomain._id,
                  domain: primaryDomain.domain,
                  isPrimary: true,
                  verified: primaryDomain.verifiedAt !== undefined,
                  verifiedAt: primaryDomain.verifiedAt ?? null,
                },
          trustedDomains: verifiedDomains.map((domain) => ({
            domainId: domain._id,
            domain: domain.domain,
            isPrimary: Boolean(domain.isPrimary),
            verified: true,
            verifiedAt: domain.verifiedAt ?? null,
          })),
          pendingChallenges,
          trust: {
            domainDiscoveryReady: verifiedDomains.length > 0,
            primaryDomainVerified,
            automaticLinkingEligible:
              primaryDomainVerified && connection.status === "active" && verifiedDomains.length > 0,
          },
          warnings,
          nextSteps,
        };
      },
      remove: async (ctx: ComponentCtx, args: { id: string }) => {
        await removeConnectionDomain(ctx, config.component.connection, args.id);
      },
      verification: {
        request: async (ctx: ComponentCtx, args: { connectionId: string; domain: string }) => {
          const connection = await loadConnectionOrThrow(ctx, args.connectionId);
          const normalizedDomain = normalizeDomain(args.domain);
          const domains = await listConnectionDomains(
            ctx,
            config.component.connection,
            connection._id,
          );
          const domain = domains.find(
            (entry: (typeof domains)[number]) => entry.domain === normalizedDomain,
          );
          if (!domain) {
            throw convexError(
              ErrorCode.INVALID_PARAMETERS,
              "Domain is not attached to this connection.",
            );
          }

          const requestedAt = Date.now();
          const expiresAt = requestedAt + GROUP_CONNECTION_DOMAIN_VERIFICATION_TTL_MS;
          const token = generateRandomString(32, INVITE_TOKEN_ALPHABET);
          const tokenHash = await sha256(token);
          const recordName = getDomainVerificationRecordName(normalizedDomain);

          await upsertConnectionDomainVerification(ctx, config.component.connection, {
            connectionId: connection._id,
            groupId: connection.groupId,
            domainId: domain._id,
            domain: normalizedDomain,
            recordName,
            token,
            tokenHash,
            requestedAt,
            expiresAt,
          });

          await emitGroupAuthEvent(ctx, {
            connectionId: connection._id,
            groupId: connection.groupId,
            kind: "connection.domain.verification_requested",
            actor: { type: "system" },
            subject: { type: "connection", id: domain._id },
            data: {
              connectionId: connection._id,
              domain: normalizedDomain,
              recordName,
              expiresAt,
            },
          });

          return {
            connectionId: connection._id,
            domain: normalizedDomain,
            requestedAt,
            expiresAt,
            challenge: {
              recordType: "TXT" as const,
              recordName,
              recordValue: token,
            },
          };
        },
        confirm: async (ctx: ComponentCtx, args: { connectionId: string; domain: string }) => {
          const connection = await loadConnectionOrThrow(ctx, args.connectionId);
          const normalizedDomain = normalizeDomain(args.domain);
          const domains = await listConnectionDomains(
            ctx,
            config.component.connection,
            connection._id,
          );
          const domain = domains.find(
            (entry: (typeof domains)[number]) => entry.domain === normalizedDomain,
          );
          if (!domain) {
            throw convexError(
              ErrorCode.INVALID_PARAMETERS,
              "Domain is not attached to this connection.",
            );
          }

          if (domain.verifiedAt !== undefined) {
            return {
              connectionId: connection._id,
              domain: normalizedDomain,
              verifiedAt: domain.verifiedAt,
              checks: [
                {
                  name: "domain_verified",
                  ok: true,
                  message: "Domain is already verified.",
                },
              ],
            };
          }

          const verification = await getConnectionDomainVerification(
            ctx,
            config.component.connection,
            domain._id,
          );
          const checks: Array<{ name: string; ok: boolean; message?: string }> = [];
          if (!verification) {
            checks.push({
              name: "verification_requested",
              ok: false,
              message: "No active domain verification challenge exists.",
            });
            return {
              connectionId: connection._id,
              domain: normalizedDomain,
              checks,
            };
          }

          checks.push({ name: "verification_requested", ok: true });

          if (verification.expiresAt < Date.now()) {
            await removeConnectionDomainVerification(ctx, config.component.connection, domain._id);
            checks.push({
              name: "challenge_active",
              ok: false,
              message: "The verification challenge expired. Request a new one.",
            });
            return {
              connectionId: connection._id,
              domain: normalizedDomain,
              checks,
            };
          }

          checks.push({ name: "challenge_active", ok: true });

          let txtValues: string[];
          try {
            txtValues = await resolveTxtValues(verification.recordName);
          } catch (error) {
            throw convexError(
              ErrorCode.INTERNAL_ERROR,
              error instanceof Error ? error.message : "Failed to resolve DNS TXT records.",
            );
          }

          checks.push({
            name: "dns_record_present",
            ok: txtValues.length > 0,
            message:
              txtValues.length > 0
                ? undefined
                : `No TXT records found at ${verification.recordName}.`,
          });

          const matches = txtValues.includes(verification.token);
          checks.push({
            name: "dns_record_matches",
            ok: matches,
            message: matches
              ? undefined
              : `TXT record at ${verification.recordName} does not match the expected value.`,
          });

          if (!checks.every((check) => check.ok)) {
            return {
              connectionId: connection._id,
              domain: normalizedDomain,
              checks,
            };
          }

          const verifiedAt = Date.now();
          await verifyConnectionDomain(ctx, config.component.connection, {
            domainId: domain._id,
            verifiedAt,
          });

          await emitGroupAuthEvent(ctx, {
            connectionId: connection._id,
            groupId: connection.groupId,
            kind: "connection.domain.verified",
            actor: { type: "system" },
            subject: { type: "connection", id: domain._id },
            data: { connectionId: connection._id, domain: normalizedDomain, verifiedAt },
          });

          return {
            connectionId: connection._id,
            domain: normalizedDomain,
            verifiedAt,
            checks,
          };
        },
      },
    },
    saml: {
      set: async <DataModel extends GenericDataModel>(
        ctx: GenericActionCtx<DataModel>,
        data: {
          connectionId: string;
          metadata: {
            xml?: string;
            url?: string;
          };
          domains?: string[];
          request?: {
            signAuthnRequests?: boolean;
            nameIdFormat?: string;
            forceAuthn?: boolean;
            authnContextClassRefs?: string[];
          };
          security?: {
            requireSignedAssertions?: boolean;
            requireTimestamps?: boolean;
            clockSkewSeconds?: number;
            weakAlgorithmHandling?: "warn" | "reject";
            maxMetadataSize?: number;
            maxResponseSize?: number;
          };
          serviceProvider?: {
            entityId?: string;
            acsUrl?: string;
            sloUrl?: string;
            signingCert?: string | string[];
            encryptCert?: string | string[];
            privateKey?: string;
            privateKeyPass?: string;
            encPrivateKey?: string;
            encPrivateKeyPass?: string;
          };
          profile?: {
            mapping?: {
              subject?: string;
              email?: string;
              name?: string;
              firstName?: string;
              lastName?: string;
              image?: string;
              groups?: string;
              roles?: string;
            };
            extraFields?: Record<string, string>;
          };
        },
      ) => {
        let connection;
        try {
          connection = await getGroupConnection(
            ctx,
            config.component.connection,
            data.connectionId,
          );
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load connection.");
        }
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }
        if (connection.protocol !== "saml") {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "This connection is not a SAML connection.",
          );
        }
        const metadataUrl =
          typeof data.metadata.url === "string" && data.metadata.url.length > 0
            ? data.metadata.url
            : undefined;
        let metadataXml: string;
        if (metadataUrl) {
          assertSafeIdpFetchUrl(metadataUrl);
          try {
            metadataXml = await retryWithBackoff(async () =>
              ctx.runAction(config.component.connection.cache.samlMetadata, { url: metadataUrl }),
            );
          } catch (error) {
            throw convexError(
              ErrorCode.INVALID_PARAMETERS,
              error instanceof Error ? error.message : "Failed to fetch SAML metadata",
            );
          }
        } else if (data.metadata.xml) {
          metadataXml = data.metadata.xml;
        } else {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "SAML registration requires metadataXml or metadataUrl.",
          );
        }

        let parsed;
        try {
          parsed = parseSamlIdpMetadataChecked({
            metadataXml,
            config: { protocols: { saml: { security: data.security } } },
          });
        } catch (error) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            error instanceof Error
              ? `Failed to parse SAML metadata: ${error.message}`
              : "Failed to parse SAML metadata.",
          );
        }
        // Fail closed: an IdP whose metadata declares no usable signing
        // certificate can never have its assertions verified, so it must not be
        // activated. Reject before persisting `status: "active"` below.
        const setIdpSigningCert = parsed.signingCert;
        const setHasUsableSigningCert =
          typeof setIdpSigningCert === "string"
            ? setIdpSigningCert.trim().length > 0
            : Array.isArray(setIdpSigningCert) &&
              setIdpSigningCert.some((cert) => typeof cert === "string" && cert.trim().length > 0);
        if (!setHasUsableSigningCert) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "SAML IdP metadata has no usable signing certificate. A signing certificate is required to verify assertions before the connection can be activated.",
          );
        }
        log("DEBUG", "[group-connection] saml:configure:parsed", {
          connectionId: data.connectionId,
          metadataUrl,
          entityId: parsed.entityId,
          issuer: parsed.issuer,
        });

        const baseConfig = upsertProtocolConfig(connection.config, "saml", {
          enabled: true,
          idp: {
            metadataUrl,
            metadataXml,
            ...parsed,
          },
          serviceProvider: data.serviceProvider,
          request: {
            signAuthnRequests: data.request?.signAuthnRequests ?? parsed.wantsSignedAuthnRequests,
            nameIdFormat: data.request?.nameIdFormat,
            forceAuthn: data.request?.forceAuthn,
            authnContextClassRefs: data.request?.authnContextClassRefs,
          },
          profile: {
            mapping: data.profile?.mapping,
            extraFields: data.profile?.extraFields,
          },
          security: data.security,
        });
        const normalizedDomains = data.domains?.map(normalizeDomain);
        const nextConfig = normalizedDomains
          ? { ...baseConfig, domains: normalizedDomains }
          : baseConfig;
        const nextSamlConfig =
          (nextConfig.protocols?.saml as SamlConfigShape | undefined) ?? undefined;
        log("DEBUG", "[group-connection] saml:configure:nextConfig", {
          connectionId: data.connectionId,
          entityId: nextSamlConfig?.idp?.entityId ?? null,
          issuer: nextSamlConfig?.idp?.issuer ?? null,
          metadataUrl: nextSamlConfig?.idp?.metadataUrl ?? null,
          hasMetadataXml: typeof nextSamlConfig?.idp?.metadataXml === "string",
        });

        try {
          await updateGroupConnection(ctx, config.component.connection, {
            connectionId: connection._id,
            patch: {
              status: "active",
              config: nextConfig,
            },
          });
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to persist SAML registration.");
        }

        if (normalizedDomains) {
          for (const [index, domain] of normalizedDomains.entries()) {
            try {
              await createConnectionDomain(ctx, config.component.connection, {
                connectionId: connection._id,
                groupId: connection.groupId,
                domain,
                isPrimary: index === 0,
              });
            } catch {
              throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to persist connection domain.");
            }
          }
        }

        try {
          await emitGroupAuthEvent(ctx, {
            connectionId: connection._id,
            groupId: connection.groupId,
            kind: "connection.saml.set",
            actor: { type: "system" },
            subject: { type: "connection", id: connection._id },
            data: {
              connectionId: connection._id,
              metadataUrl: metadataUrl,
              domains: normalizedDomains,
            },
          });
        } catch {
          throw convexError(
            ErrorCode.INTERNAL_ERROR,
            "Failed to record SAML registration audit event.",
          );
        }

        return {
          connectionId: connection._id,
          groupId: connection.groupId,
        };
      },
      refresh: async (ctx: ComponentActionCtx, data: { connectionId: string }) => {
        let connection;
        try {
          connection = await getGroupConnection(
            ctx,
            config.component.connection,
            data.connectionId,
          );
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load connection.");
        }
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }
        const samlConfig = (connection.config as { protocols?: { saml?: SamlConfigShape } })
          ?.protocols?.saml;
        if (connection.protocol !== "saml") {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "This connection is not a SAML connection.",
          );
        }
        if (typeof samlConfig?.idp?.metadataUrl !== "string") {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "SAML metadataUrl is not configured.");
        }
        const metadataUrl = samlConfig.idp.metadataUrl;
        assertSafeIdpFetchUrl(metadataUrl);
        let metadataXml: string;
        try {
          metadataXml = await retryWithBackoff(async () =>
            ctx.runAction(config.component.connection.cache.samlMetadata, { url: metadataUrl }),
          );
        } catch (error) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            error instanceof Error ? error.message : "Failed to fetch SAML metadata",
          );
        }
        let parsed;
        try {
          parsed = parseSamlIdpMetadataChecked({
            metadataXml,
            config: connection.config,
          });
        } catch (error) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            error instanceof Error
              ? `Failed to parse SAML metadata: ${error.message}`
              : "Failed to parse SAML metadata.",
          );
        }
        // Fail closed: refreshed IdP metadata that yields no usable signing
        // certificate would leave the connection unable to verify assertions.
        // Reject rather than overwrite the stored config with cert-less metadata.
        const refreshIdpSigningCert = parsed.signingCert;
        const refreshHasUsableSigningCert =
          typeof refreshIdpSigningCert === "string"
            ? refreshIdpSigningCert.trim().length > 0
            : Array.isArray(refreshIdpSigningCert) &&
              refreshIdpSigningCert.some(
                (cert) => typeof cert === "string" && cert.trim().length > 0,
              );
        if (!refreshHasUsableSigningCert) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "SAML IdP metadata has no usable signing certificate. A signing certificate is required to verify assertions.",
          );
        }
        const nextConfig = upsertProtocolConfig(connection.config, "saml", {
          enabled: true,
          idp: {
            metadataUrl,
            metadataXml,
            ...parsed,
          },
          serviceProvider: (samlConfig as { serviceProvider?: Record<string, unknown> })
            .serviceProvider,
          request: samlConfig.request,
          profile: samlConfig.profile,
          security: samlConfig.security,
        });
        try {
          await updateGroupConnection(ctx, config.component.connection, {
            connectionId: connection._id,
            patch: {
              status: connection.status,
              config: nextConfig,
            },
          });
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to persist refreshed SAML metadata.");
        }
        try {
          await emitGroupAuthEvent(ctx, {
            connectionId: connection._id,
            groupId: connection.groupId,
            kind: "connection.saml.refreshed",
            actor: { type: "system" },
            subject: { type: "connection", id: connection._id },
            data: {
              connectionId: connection._id,
              metadataUrl,
            },
          });
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to record SAML refresh audit event.");
        }
        return {
          connectionId: connection._id,
          groupId: connection.groupId,
        };
      },
      get: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        let connection;
        try {
          connection = await getGroupConnection(ctx, config.component.connection, connectionId);
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load connection.");
        }
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }
        return getPublicSamlConfig(connection.config);
      },
      status: (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        return getGroupConnection(ctx, config.component.connection, connectionId).then(
          (connection) => {
            if (!connection) {
              throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
            }
            const currentConfig = getPublicSamlConfig(connection.config);
            const configured = currentConfig.enabled === true;
            const ready =
              configured &&
              typeof (currentConfig.idp as Record<string, unknown> | undefined)?.entityId ===
                "string";
            return {
              connectionId,
              configured,
              ready,
              config: currentConfig,
              checks: [
                {
                  name: "saml_configured",
                  ok: configured,
                  message: configured ? undefined : "SAML is not configured.",
                },
              ],
            };
          },
        );
      },
      metadata: async (
        ctx: ComponentReadCtx,
        opts: {
          connectionId: string;
          entityId?: string;
          acsUrl?: string;
          sloUrl?: string;
        },
      ) => {
        const connection = await getGroupConnection(
          ctx,
          config.component.connection,
          opts.connectionId,
        );
        if (!connection) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "Connection not found.");
        }

        return createServiceProviderMetadata(
          getSamlServiceProviderOptions({
            rootUrl: requireEnv("CONVEX_SITE_URL"),
            source: { kind: "connection", id: connection._id },
            config: connection.config,
            overrides: {
              entityId: opts.entityId,
              acsUrl: opts.acsUrl,
              sloUrl: opts.sloUrl,
            },
          }),
        );
      },
      /**
       * Validate the stored SAML config for an group connection.
       *
       * Re-parses IdP metadata, checks signing cert presence, and verifies
       * SP metadata can be generated. Returns a structured result with
       * per-check details rather than throwing on first failure.
       */
      validate: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        const checks: Array<{
          name: string;
          ok: boolean;
          message?: string;
        }> = [];

        const connection = await getGroupConnection(ctx, config.component.connection, connectionId);

        if (!connection) {
          return {
            ok: false,
            connectionId,
            checks: [
              {
                name: "group_connection_exists",
                ok: false,
                message: "Connection not found.",
              },
            ],
          };
        }

        const samlConfig = (connection.config as { protocols?: { saml?: SamlConfigShape } })
          ?.protocols?.saml;
        const samlConfigured =
          samlConfig?.enabled === true && typeof samlConfig?.idp?.metadataXml === "string";

        checks.push({
          name: "saml_configured",
          ok: samlConfigured,
          message: samlConfigured ? undefined : "SAML is not configured.",
        });

        const hasIdpMetadata =
          typeof samlConfig?.idp?.metadataXml === "string" && samlConfig.idp.metadataXml.length > 0;
        checks.push({
          name: "idp_metadata_present",
          ok: hasIdpMetadata,
          message: hasIdpMetadata ? undefined : "IdP metadata XML is missing.",
        });

        const reparsedIdp =
          hasIdpMetadata && typeof samlConfig?.idp?.metadataXml === "string"
            ? (() => {
                try {
                  return parseSamlIdpMetadataChecked({
                    metadataXml: samlConfig.idp.metadataXml,
                    config: connection.config,
                  });
                } catch {
                  return null;
                }
              })()
            : null;
        log("DEBUG", "[group-connection] saml:validate:idp", {
          connectionId,
          entityId: samlConfig?.idp?.entityId ?? null,
          issuer: samlConfig?.idp?.issuer ?? null,
          metadataUrl: samlConfig?.idp?.metadataUrl ?? null,
          reparsedEntityId: reparsedIdp?.entityId ?? null,
          reparsedIssuer: reparsedIdp?.issuer ?? null,
        });
        const hasEntityId =
          (typeof samlConfig?.idp?.entityId === "string" && samlConfig.idp.entityId.length > 0) ||
          (typeof samlConfig?.idp?.issuer === "string" && samlConfig.idp.issuer.length > 0) ||
          (typeof reparsedIdp?.entityId === "string" && reparsedIdp.entityId.length > 0) ||
          (typeof reparsedIdp?.issuer === "string" && reparsedIdp.issuer.length > 0);
        checks.push({
          name: "idp_entity_id",
          ok: hasEntityId,
          message: hasEntityId ? undefined : "IdP entityId could not be parsed from metadata.",
        });

        let spMetadataOk = false;
        let spMetadataMessage: string | undefined;
        if (samlConfigured) {
          try {
            createServiceProviderMetadata(
              getSamlServiceProviderOptions({
                rootUrl: requireEnv("CONVEX_SITE_URL"),
                source: { kind: "connection", id: connection._id },
                config: connection.config,
                overrides: {},
              }),
            );
            spMetadataOk = true;
          } catch (e) {
            spMetadataMessage = e instanceof Error ? e.message : "SP metadata generation failed.";
          }
        } else {
          spMetadataMessage = "Skipped — SAML not configured.";
        }
        checks.push({
          name: "sp_metadata_generates",
          ok: spMetadataOk,
          message: spMetadataMessage,
        });

        const requiresSignedAssertions = samlConfig?.security?.requireSignedAssertions === true;
        const hasSigningCert = reparsedIdp?.signingCert !== null;
        checks.push({
          name: "signed_assertions_compatible",
          ok: !requiresSignedAssertions || hasSigningCert,
          message:
            !requiresSignedAssertions || hasSigningCert
              ? undefined
              : "Signed assertions are required but the IdP metadata has no signing certificate.",
        });

        const signAuthnRequests = samlConfig?.request?.signAuthnRequests === true;
        const hasSpPrivateKey =
          typeof (samlConfig as { serviceProvider?: { privateKey?: string } } | undefined)
            ?.serviceProvider?.privateKey === "string";
        checks.push({
          name: "authn_request_signing_compatible",
          ok: !signAuthnRequests || hasSpPrivateKey,
          message:
            !signAuthnRequests || hasSpPrivateKey
              ? undefined
              : "signAuthnRequests is enabled but no SP privateKey is configured.",
        });

        checks.push({
          name: "timestamp_validation_configured",
          ok: true,
          message:
            samlConfig?.security?.requireTimestamps === true
              ? `Timestamp validation enabled with clock skew ${samlConfig.security.clockSkewSeconds ?? 300} seconds.`
              : "Timestamp validation uses compatibility defaults.",
        });

        return {
          ok: checks.every((c) => c.ok),
          connectionId: connection._id,
          checks,
        };
      },
    },
    policy,
    oidc: {
      /**
       * Register or update connection OIDC connection settings.
       *
       * Persists protocol config under `connection.config.protocols.oidc` and
       * emits a `connection.oidc.set` auth event.
       */
      set: async (
        ctx: ComponentCtx,
        data: {
          connectionId: string;
          discovery: {
            issuer?: string;
            discoveryUrl?: string;
            jwksUri?: string;
            audience?: string | string[];
          };
          client: {
            id: string;
            secret?: string;
            authMethod?: "client_secret_post" | "client_secret_basic";
          };
          request?: {
            scopes?: string[];
            loginHint?: string;
            authorizationParams?: Record<string, string>;
          };
          security?: {
            clockToleranceSeconds?: number;
            strictIssuer?: boolean;
          };
          profile?: {
            mapping?: OIDCClaimMapping;
            extraFields?: Record<string, string>;
          };
        },
      ) => {
        if (data.discovery.issuer === undefined && data.discovery.discoveryUrl === undefined) {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "OIDC registration requires issuer or discoveryUrl.",
          );
        }

        let connection;
        try {
          connection = await getGroupConnection(
            ctx,
            config.component.connection,
            data.connectionId,
          );
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load connection.");
        }
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }
        if (connection.protocol !== "oidc") {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "This connection is not an OIDC connection.",
          );
        }
        const nextConfig = upsertProtocolConfig(connection.config, "oidc", {
          enabled: true,
          discovery: {
            issuer: data.discovery.issuer,
            discoveryUrl: data.discovery.discoveryUrl,
            jwksUri: data.discovery.jwksUri,
            audience: data.discovery.audience,
          },
          client: {
            id: data.client.id,
            authMethod: data.client.authMethod,
          },
          request: {
            scopes: data.request?.scopes ?? ["openid", "profile", "email"],
            loginHint: data.request?.loginHint,
            authorizationParams: data.request?.authorizationParams,
          },
          security: {
            clockToleranceSeconds: data.security?.clockToleranceSeconds,
            strictIssuer: data.security?.strictIssuer,
          },
          profile: {
            mapping: data.profile?.mapping,
            extraFields: data.profile?.extraFields,
          },
        });

        try {
          await updateGroupConnection(ctx, config.component.connection, {
            connectionId: data.connectionId,
            patch: { config: nextConfig },
          });
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to persist OIDC registration.");
        }

        if (data.client.secret !== undefined) {
          let ciphertext: string;
          try {
            ciphertext = await encryptSecret(data.client.secret!);
          } catch {
            throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to encrypt OIDC client secret.");
          }
          try {
            await upsertGroupConnectionSecret(ctx, config.component.connection, {
              connectionId: data.connectionId,
              groupId: connection.groupId,
              kind: GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
              ciphertext,
              updatedAt: Date.now(),
            });
          } catch {
            throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to persist OIDC client secret.");
          }
        }

        try {
          await emitGroupAuthEvent(ctx, {
            connectionId: data.connectionId,
            groupId: connection.groupId,
            kind: "connection.oidc.set",
            actor: { type: "system" },
            subject: { type: "connection", id: data.connectionId },
            data: {
              connectionId: data.connectionId,
              issuer: data.discovery.issuer,
              discoveryUrl: data.discovery.discoveryUrl,
              jwksUri: data.discovery.jwksUri,
              audience: data.discovery.audience,
              tokenEndpointAuthMethod: data.client.authMethod,
            },
          });
        } catch {
          throw convexError(
            ErrorCode.INTERNAL_ERROR,
            "Failed to record OIDC registration audit event.",
          );
        }

        let secret;
        try {
          secret = await getGroupConnectionSecret(
            ctx,
            data.connectionId,
            GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
          );
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load OIDC secret metadata.");
        }

        return withOidcSecretState(getPublicOidcConfig(nextConfig), secret !== null);
      },
      /**
       * Fetch the stored OIDC config for an connection.
       */
      get: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        let connection;
        try {
          connection = await getGroupConnection(ctx, config.component.connection, connectionId);
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load connection.");
        }
        if (connection === null) {
          throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
        }

        let secret;
        try {
          secret = await getGroupConnectionSecret(
            ctx,
            connection._id,
            GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
          );
        } catch {
          throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load OIDC secret metadata.");
        }

        return withOidcSecretState(getPublicOidcConfig(connection.config), secret !== null);
      },
      status: (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        return Promise.all([
          getGroupConnection(ctx, config.component.connection, connectionId),
          getGroupConnectionSecret(ctx, connectionId, GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND),
        ]).then(([connection, secret]) => {
          if (!connection) {
            throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
          }
          const currentConfig = getPublicOidcConfig(connection.config);
          const oidcConfig = getOidcConfig(connection.config);
          const configured =
            currentConfig.enabled === true &&
            typeof oidcConfig.client?.id === "string" &&
            (typeof oidcConfig.discovery?.issuer === "string" ||
              typeof oidcConfig.discovery?.discoveryUrl === "string");
          const ready = configured && secret !== null;
          return {
            connectionId,
            configured,
            ready,
            config: withOidcSecretState(currentConfig, secret !== null),
            checks: [
              {
                name: "oidc_configured",
                ok: configured,
                message: configured ? undefined : "OIDC is not configured.",
              },
              {
                name: "client_secret_stored",
                ok: secret !== null,
                message: secret !== null ? undefined : "OIDC client secret is missing.",
              },
            ],
          };
        });
      },
      /**
       * Resolve group Connection sign-in route from connection id, domain, or
       * user email domain.
       */
      signIn: async (
        ctx: ComponentReadCtx,
        data: {
          connectionId?: string;
          email?: string;
          domain?: string;
          redirectTo?: string;
          loginHint?: string;
        },
      ) => {
        log("DEBUG", "[group-connection] resolver:start", {
          connectionId: data.connectionId,
          email: data.email,
          domain: data.domain,
          redirectTo: data.redirectTo,
        });

        let connection;
        if (data.connectionId !== undefined) {
          try {
            connection = await getGroupConnection(
              ctx,
              config.component.connection,
              data.connectionId!,
            );
          } catch {
            throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to load connection.");
          }
          if (connection === null) {
            throw convexError(ErrorCode.INVALID_PARAMETERS, connectionNotFoundError);
          }
        } else if (data.domain !== undefined || data.email !== undefined) {
          let result;
          try {
            result = await getGroupConnectionByDomain(
              ctx,
              config.component.connection,
              normalizeDomain(data.domain ?? String(data.email).split("@").pop() ?? ""),
            );
          } catch {
            throw convexError(ErrorCode.INTERNAL_ERROR, "Failed to resolve connection by domain.");
          }
          log("DEBUG", "[group-connection] resolver:domainLookup", result);
          if (result?.connection && result.domain?.verifiedAt !== undefined) {
            connection = result.connection;
          } else {
            throw convexError(
              ErrorCode.INVALID_PARAMETERS,
              "No group connection matched the provided input.",
            );
          }
        } else {
          throw convexError(
            ErrorCode.INVALID_PARAMETERS,
            "No group connection matched the provided input.",
          );
        }

        if (connection.status !== "active") {
          throw convexError(ErrorCode.INVALID_PARAMETERS, "Group connection is not active.");
        }

        const protocol = resolveGroupConnectionProtocol(connection);
        log("DEBUG", "[group-connection] resolver:connection", {
          connectionId: connection._id,
          status: connection.status,
          protocol,
        });
        const { signInPath, callbackPath, providerId } =
          protocol === "oidc"
            ? (() => {
                const urls = getGroupOidcUrls({
                  rootUrl: requireEnv("CONVEX_SITE_URL"),
                  connectionId: connection._id,
                  sharedRedirectURI: deps.sharedOidcRedirectURI,
                });
                return {
                  signInPath: urls.signInUrl,
                  callbackPath: urls.callbackUrl,
                  providerId: groupOidcProviderId(connection._id),
                };
              })()
            : (() => {
                const urls = getGroupSamlUrls({
                  rootUrl: requireEnv("CONVEX_SITE_URL"),
                  source: { kind: "connection", id: connection._id },
                });
                return {
                  signInPath: `${requireEnv("CONVEX_SITE_URL")}/connections/${connection._id}/saml/signin`,
                  callbackPath: urls.acsUrl,
                  providerId: groupSamlProviderId(connection._id),
                };
              })();
        log("DEBUG", "[group-connection] resolver:paths", {
          connectionId: connection._id,
          signInPath,
          callbackPath,
        });
        return {
          connectionId: connection._id,
          protocol,
          providerId,
          signInPath:
            protocol === "oidc" && typeof data.loginHint === "string"
              ? (() => {
                  const signInUrl = new URL(signInPath);
                  signInUrl.searchParams.set("loginHint", data.loginHint);
                  return signInUrl.toString();
                })()
              : signInPath,
          callbackPath,
          redirectTo: data.redirectTo,
        };
      },
      /**
       * Validate the stored OIDC config for an group connection.
       *
       * Fetches the OIDC discovery document from the configured issuer or
       * discoveryUrl, verifies required fields are present, and checks that
       * clientId is set. Returns a structured result with per-check details.
       */
      validate: async (ctx: ComponentReadCtx, args: { connectionId: string }) => {
        const { connectionId } = args;
        const checks: Array<{
          name: string;
          ok: boolean;
          message?: string;
        }> = [];

        const connection = await getGroupConnection(ctx, config.component.connection, connectionId);

        if (!connection) {
          return {
            ok: false,
            connectionId,
            checks: [
              {
                name: "group_connection_exists",
                ok: false,
                message: "Connection not found.",
              },
            ],
          };
        }

        const oidc = getOidcConfig(connection.config);
        const secret = await getGroupConnectionSecret(
          ctx,
          connection._id,
          GROUP_CONNECTION_OIDC_CLIENT_SECRET_KIND,
        );
        const oidcConfigured =
          oidc.enabled === true && typeof oidc.client?.id === "string" && oidc.client.id.length > 0;

        checks.push({
          name: "oidc_configured",
          ok: oidcConfigured,
          message: oidcConfigured ? undefined : "OIDC is not configured.",
        });

        const hasClientId = typeof oidc.client?.id === "string" && oidc.client.id.length > 0;
        checks.push({
          name: "client_id_present",
          ok: hasClientId,
          message: hasClientId ? undefined : "clientId is missing.",
        });

        checks.push({
          name: "client_secret_stored",
          ok: secret !== null,
          message: secret !== null ? undefined : "OIDC client secret is missing.",
        });

        const discoveryConfig =
          typeof oidc.discovery === "object" && oidc.discovery !== null
            ? (oidc.discovery as Record<string, unknown>)
            : {};
        const clientConfig =
          typeof oidc.client === "object" && oidc.client !== null
            ? (oidc.client as Record<string, unknown>)
            : {};
        const discoveryTarget =
          (discoveryConfig.discoveryUrl as string | undefined) ??
          (discoveryConfig.issuer as string | undefined);
        const hasDiscovery = typeof discoveryTarget === "string" && discoveryTarget.length > 0;
        checks.push({
          name: "issuer_or_discovery_url_present",
          ok: hasDiscovery,
          message: hasDiscovery ? undefined : "issuer or discoveryUrl is missing.",
        });

        let discoveryOk = false;
        let discoveryMessage: string | undefined;
        if (hasDiscovery) {
          const discoveryUrl =
            typeof discoveryConfig.discoveryUrl === "string" &&
            discoveryConfig.discoveryUrl.length > 0
              ? discoveryConfig.discoveryUrl
              : `${String(discoveryConfig.issuer)}/.well-known/openid-configuration`;
          try {
            assertSafeIdpFetchUrl(discoveryUrl);
            const res = await fetch(discoveryUrl, {
              headers: { Accept: "application/json" },
              redirect: "manual",
              signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) {
              discoveryMessage = `Discovery endpoint returned ${res.status}.`;
            } else {
              const json = (await res.json()) as Record<string, unknown>;
              if (typeof json.issuer !== "string") {
                discoveryMessage = "Discovery document is missing issuer field.";
              } else if (typeof json.authorization_endpoint !== "string") {
                discoveryMessage = "Discovery document is missing authorization_endpoint.";
              } else if (typeof json.token_endpoint !== "string") {
                discoveryMessage = "Discovery document is missing token_endpoint.";
              } else if (
                discoveryConfig.jwksUri === undefined &&
                typeof json.jwks_uri !== "string"
              ) {
                discoveryMessage =
                  "Discovery document is missing jwks_uri and no jwksUri override is configured.";
              } else {
                discoveryOk = true;
              }
            }
          } catch (e) {
            discoveryMessage =
              e instanceof Error
                ? `Discovery fetch failed: ${e.message}`
                : "Discovery fetch failed.";
          }
        } else {
          discoveryMessage = "Skipped — issuer or discoveryUrl not set.";
        }
        checks.push({
          name: "discovery_reachable",
          ok: discoveryOk,
          message: discoveryMessage,
        });

        const hasValidTokenAuthMethod =
          clientConfig.authMethod === undefined ||
          clientConfig.authMethod === "client_secret_post" ||
          clientConfig.authMethod === "client_secret_basic";
        checks.push({
          name: "token_endpoint_auth_method_supported",
          ok: hasValidTokenAuthMethod,
          message: hasValidTokenAuthMethod
            ? undefined
            : "tokenEndpointAuthMethod must be client_secret_post or client_secret_basic.",
        });

        const hasJwksUri =
          discoveryConfig.jwksUri === undefined ||
          (typeof discoveryConfig.jwksUri === "string" && discoveryConfig.jwksUri.length > 0);
        checks.push({
          name: "jwks_uri_present",
          ok: hasJwksUri,
          message: hasJwksUri ? undefined : "jwksUri is empty.",
        });

        const hasAudience =
          discoveryConfig.audience === undefined ||
          typeof discoveryConfig.audience === "string" ||
          (Array.isArray(discoveryConfig.audience) &&
            discoveryConfig.audience.every((value) => typeof value === "string"));
        checks.push({
          name: "audience_valid",
          ok: hasAudience,
          message: hasAudience ? undefined : "audience must be a string or string array.",
        });

        return {
          ok: checks.every((c) => c.ok),
          connectionId: connection._id,
          checks,
        };
      },
    },
    scim,
    audit: {
      list: async (
        ctx: ComponentReadCtx,
        data: {
          connectionId?: string;
          groupId?: string;
          paginationOpts: { numItems: number; cursor: string | null };
        },
      ) => {
        return await ctx.runQuery(config.component.connection.audit.list, data);
      },
    },
    webhook,
  };
}
