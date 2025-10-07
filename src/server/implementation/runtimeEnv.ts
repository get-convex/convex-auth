import { ConvexAuthMaterializedConfig } from "../types.js";

export type AuthRuntimeEnv = {
  siteUrl?: string;
  customAuthSiteUrl?: string;
};

export function collectRuntimeEnv(): AuthRuntimeEnv | undefined {
  const siteUrl = process.env.CONVEX_SITE_URL;
  const customAuthSiteUrl = process.env.CUSTOM_AUTH_SITE_URL;
  if (siteUrl === undefined && customAuthSiteUrl === undefined) {
    return undefined;
  }
  return {
    siteUrl: siteUrl ?? undefined,
    customAuthSiteUrl: customAuthSiteUrl ?? undefined,
  };
}

export function mergeRuntimeEnv(
  config: Pick<ConvexAuthMaterializedConfig, "siteUrl" | "customAuthSiteUrl">,
  runtime?: AuthRuntimeEnv,
): AuthRuntimeEnv {
  return {
    siteUrl: runtime?.siteUrl ?? config.siteUrl,
    customAuthSiteUrl:
      runtime?.customAuthSiteUrl ??
      config.customAuthSiteUrl ??
      runtime?.siteUrl ??
      config.siteUrl,
  };
}

export function requireSiteUrl(
  config: Pick<ConvexAuthMaterializedConfig, "siteUrl">,
  runtime?: AuthRuntimeEnv,
): string {
  const siteUrl =
    runtime?.siteUrl ??
    config.siteUrl ??
    process.env.CONVEX_SITE_URL ??
    process.env.CUSTOM_AUTH_SITE_URL;
  if (siteUrl === undefined) {
    throw new Error(
      "Missing environment variable `CONVEX_SITE_URL`. Set it in Convex or pass `siteUrl` to `convexAuth`.",
    );
  }
  return siteUrl;
}

export function resolveAuthBaseUrl(
  config: Pick<ConvexAuthMaterializedConfig, "siteUrl" | "customAuthSiteUrl">,
  runtime?: AuthRuntimeEnv,
): string {
  return (
    runtime?.customAuthSiteUrl ??
    config.customAuthSiteUrl ??
    runtime?.siteUrl ??
    config.siteUrl ??
    process.env.CUSTOM_AUTH_SITE_URL ??
    requireSiteUrl(config, runtime)
  );
}
