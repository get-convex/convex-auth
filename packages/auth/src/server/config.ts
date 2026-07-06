import { envOptionalString } from "./env";
import {
  AuthProviderConfig,
  AuthProviderMaterializedConfig,
  AuthTelemetryConfig,
  ConvexAuthConfig,
  PermissionsConfig,
} from "./types";
import { normalizeAuthPath } from "./url";

/**
 * Resolve raw provider configs into materialized form and apply defaults.
 */
export function configDefaults(config_: ConvexAuthConfig) {
  const config = materializeAndDefaultProviders(config_);
  const extraProviders = config.providers
    .filter((p) => p.type === "credentials")
    .map((p) => p.extraProviders)
    .flat()
    .filter((p) => p !== undefined);
  return {
    ...config,
    path: normalizeAuthPath(config.path),
    permissions: normalizePermissionsConfig(config.permissions),
    telemetry: normalizeTelemetryConfig(config.telemetry),
    extraProviders: materializeProviders(extraProviders),
  };
}

/**
 * List available provider IDs for error messages.
 */
export function listAvailableProviders(
  config: ReturnType<typeof configDefaults>,
  allowExtraProviders: boolean,
) {
  const availableProviders = config.providers
    .concat(allowExtraProviders ? config.extraProviders : [])
    .map((provider) => `\`${provider.id}\``);
  return availableProviders.length > 0
    ? availableProviders.join(", ")
    : "no providers have been configured";
}

function materializeProviders(providers: AuthProviderConfig[]) {
  const config: ConvexAuthConfig = {
    providers,
    component: {} as ConvexAuthConfig["component"],
  };
  materializeAndDefaultProviders(config);
  return config.providers as AuthProviderMaterializedConfig[];
}

function materializeProviderConfig(raw: AuthProviderConfig): AuthProviderMaterializedConfig {
  const resolved = typeof raw === "function" ? raw() : raw;
  const merged =
    "options" in resolved && typeof resolved.options === "object" && resolved.options !== null
      ? { ...resolved, ...resolved.options }
      : resolved;
  return merged as AuthProviderMaterializedConfig;
}

function materializeAndDefaultProviders(config_: ConvexAuthConfig) {
  const allProviders: AuthProviderMaterializedConfig[] = [];

  for (const raw of config_.providers) {
    allProviders.push(materializeProviderConfig(raw));
  }

  const config = { ...config_, providers: allProviders };

  config.providers.forEach((provider) => {
    if (provider.type === "phone") {
      const ID = provider.id.toUpperCase().replace(/-/g, "_");
      provider.apiKey ??= envOptionalString(`AUTH_${ID}_KEY`);
    }
  });

  return config;
}

function normalizePermissionsConfig(
  permissions: ConvexAuthConfig["permissions"],
): PermissionsConfig {
  const declaredGrants = permissions?.grants;
  const grants = Array.from(new Set(declaredGrants ?? [])).sort();
  const roles = Object.fromEntries(
    Object.entries(permissions?.roles ?? {}).map(([roleId, role]) => [
      roleId,
      {
        ...(role.label ? { label: role.label } : {}),
        grants: Array.from(new Set(role.grants)).sort(),
      },
    ]),
  );
  return { grants, roles };
}

function normalizeTelemetryConfig(telemetry: ConvexAuthConfig["telemetry"]): AuthTelemetryConfig {
  const normalized: AuthTelemetryConfig = {
    includeIdentity: telemetry?.includeIdentity ?? "none",
    identityFields: telemetry?.identityFields ?? {},
    ...(telemetry?.hashIdentity ? { hashIdentity: telemetry.hashIdentity } : {}),
  };

  if (normalized.includeIdentity === "hashed" && normalized.hashIdentity === undefined) {
    throw new Error(
      'Convex Auth telemetry with `includeIdentity: "hashed"` requires a `hashIdentity` function.',
    );
  }

  return normalized;
}
