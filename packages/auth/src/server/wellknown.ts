/**
 * Content generator for cross-platform `.well-known` endpoints.
 *
 * The helper produces the exact response shape expected by Apple, Google,
 * browsers, and password managers. It reads convention env vars but accepts
 * explicit overrides; if an endpoint is not configured, it returns `null` so
 * the caller can serve a 404.
 *
 * These endpoints must be reachable from the public app/RP ID origin at root
 * `/.well-known/*`. `auth.http()` serves them from Convex; apps using a
 * separate frontend domain should route those root paths to Convex or adapt
 * this helper in their framework route handlers.
 *
 * @module
 */

import { envOptionalNumber, envOptionalString } from "./env";
import { appUrlFromEnv } from "./url";

/** Uniform shape returned by the well-known helper. Adapt to any framework. */
export type WellKnownResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Supported `/.well-known/*` endpoint names, without the `/.well-known/` prefix. */
export type WellKnownEndpoint =
  | "apple-app-site-association"
  | "assetlinks.json"
  | "webauthn"
  | "security.txt"
  | "change-password";

/** Explicit per-endpoint overrides for {@link wellKnown}, bypassing env vars. */
export type WellKnownOptions = {
  /** Options for `/.well-known/apple-app-site-association`. */
  appleAppSiteAssociation?: {
    /** Override `IOS_APP_IDS`; e.g., `["ABC123DEF.com.example.app"]`. */
    appIds?: string[];
    /** Override `IOS_APPLINK_PATHS`; default `["/auth/*", "/callback/*"]`. */
    applinkPaths?: string[];
  };
  /** Options for `/.well-known/assetlinks.json`. */
  assetLinks?: {
    apps?: Array<{ packageName: string; sha256Fingerprints: string[] }>;
  };
  /** Options for `/.well-known/security.txt`. */
  securityTxt?: {
    /** Override `SECURITY_CONTACT`. Should be a `mailto:` or `https:` URI. */
    contact?: string;
    /** Override `SECURITY_TXT_EXPIRES_DAYS`. Default 365 days from now. */
    expiresInDays?: number;
    /** RFC 5646 language tags, e.g., `["en"]`. */
    preferredLanguages?: string[];
    /** Optional canonical URL of the security.txt file (for signed copies). */
    canonical?: string;
    /** Optional public key URL for encrypted reports. */
    encryption?: string;
    /** Optional acknowledgments URL. */
    acknowledgments?: string;
    /** Optional policy URL. */
    policy?: string;
    /** Optional hiring URL. */
    hiring?: string;
  };
  /** Options for `/.well-known/change-password`. */
  changePassword?: {
    /** Override `CHANGE_PASSWORD_URL`. */
    targetUrl?: string;
  };
};

const STATIC_CACHE = "public, max-age=300, stale-while-revalidate=3600, stale-if-error=86400";

function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function ok(body: string, contentType: string): WellKnownResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": STATIC_CACHE,
    },
    body,
  };
}

function appleAppSiteAssociationResponse(
  opts?: WellKnownOptions["appleAppSiteAssociation"],
): WellKnownResponse | null {
  const appIds = opts?.appIds ?? parseList(envOptionalString("IOS_APP_IDS"));
  if (appIds.length === 0) return null;

  const applinkPaths = opts?.applinkPaths ?? parseList(envOptionalString("IOS_APPLINK_PATHS"));
  const components =
    applinkPaths.length > 0
      ? applinkPaths.map((path) => ({ "/": path }))
      : [{ "/": "/auth/*" }, { "/": "/callback/*" }];

  const body = JSON.stringify({
    applinks: {
      details: [{ appIDs: appIds, components }],
    },
    webcredentials: { apps: appIds },
  });
  return ok(body, "application/json");
}

/**
 * Generate `/.well-known/assetlinks.json` content for Android.
 *
 * Required for Android Credential Manager to surface passkeys for the app,
 * and for App Link verification (`autoVerify="true"` intent filters). Google
 * fetches this file from the WebAuthn RP ID host.
 *
 * Reads {@link ANDROID_APP_LINKS} in the format
 * `package1:FP1:FP2;package2:FP1:FP2` where each fingerprint is a colon-
 * separated SHA-256 hex string. Use `;` between apps and `:` to separate
 * package name from fingerprints (and fingerprints share the standard
 * `AA:BB:CC:...` colon format — split on `:`, the first segment is the
 * package, the rest is the fingerprint reassembled).
 *
 * For programmatic config, prefer the `apps` option which avoids parsing.
 *
 * @example Direct config
 * ```ts
 * wellKnown("assetlinks.json", { assetLinks: {
 *   apps: [{
 *     packageName: "com.example.app",
 *     sha256Fingerprints: ["AA:BB:CC:..."],
 *   }],
 * }});
 * ```
 */
function assetLinksResponse(opts?: WellKnownOptions["assetLinks"]): WellKnownResponse | null {
  const apps = opts?.apps ?? parseAndroidAppLinksEnv(envOptionalString("ANDROID_APP_LINKS"));
  if (apps.length === 0) return null;

  const body = JSON.stringify(
    apps.map((app) => ({
      relation: [
        "delegate_permission/common.get_login_creds",
        "delegate_permission/common.handle_all_urls",
      ],
      target: {
        namespace: "android_app",
        package_name: app.packageName,
        sha256_cert_fingerprints: app.sha256Fingerprints,
      },
    })),
  );
  return ok(body, "application/json");
}

function parseAndroidAppLinksEnv(
  raw: string | undefined,
): Array<{ packageName: string; sha256Fingerprints: string[] }> {
  if (raw === undefined) return [];
  const apps: Array<{ packageName: string; sha256Fingerprints: string[] }> = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const firstColon = trimmed.indexOf(":");
    if (firstColon === -1) continue;
    const packageName = trimmed.slice(0, firstColon).trim();
    const fingerprintsRaw = trimmed.slice(firstColon + 1).trim();
    if (packageName.length === 0 || fingerprintsRaw.length === 0) continue;
    apps.push({
      packageName,
      sha256Fingerprints: [fingerprintsRaw],
    });
  }
  return apps;
}

/**
 * Generate `/.well-known/webauthn` content (W3C WebAuthn Level 3).
 *
 * The happy path is the app's single frontend origin. Multi-origin RP support
 * should be handled explicitly by the app instead of hidden deployment envs.
 */
function webAuthnResponse(): WellKnownResponse | null {
  let appUrl: string;
  try {
    appUrl = appUrlFromEnv();
  } catch {
    return null;
  }
  return ok(JSON.stringify({ origins: [appUrl] }), "application/json");
}

/**
 * Generate `/.well-known/security.txt` content (RFC 9116).
 *
 * Plain-text contact info for security researchers. Reads {@link SECURITY_CONTACT}
 * (e.g., `mailto:security@example.com` or `https://example.com/security`) and
 * optional {@link SECURITY_TXT_EXPIRES_DAYS} (default 365).
 */
function securityTxtResponse(opts?: WellKnownOptions["securityTxt"]): WellKnownResponse | null {
  const contact = opts?.contact ?? envOptionalString("SECURITY_CONTACT");
  if (contact === undefined || contact.length === 0) return null;

  const days = opts?.expiresInDays ?? envOptionalNumber("SECURITY_TXT_EXPIRES_DAYS") ?? 365;
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const lines: string[] = [`Contact: ${contact}`, `Expires: ${expires}`];

  const langs = opts?.preferredLanguages;
  if (langs && langs.length > 0) {
    lines.push(`Preferred-Languages: ${langs.join(", ")}`);
  }
  if (opts?.canonical) lines.push(`Canonical: ${opts.canonical}`);
  if (opts?.encryption) lines.push(`Encryption: ${opts.encryption}`);
  if (opts?.acknowledgments) lines.push(`Acknowledgments: ${opts.acknowledgments}`);
  if (opts?.policy) lines.push(`Policy: ${opts.policy}`);
  if (opts?.hiring) lines.push(`Hiring: ${opts.hiring}`);

  const body = `${lines.join("\n")}\n`;
  return ok(body, "text/plain; charset=utf-8");
}

/**
 * Generate a 302 redirect for `/.well-known/change-password` (RFC 8615).
 *
 * Password managers (1Password, iCloud Keychain, Bitwarden, Chrome) deep-link
 * here when the user picks "Change password". The route should redirect to
 * the actual change-password UI in your app.
 *
 * Reads {@link CHANGE_PASSWORD_URL}.
 */
function changePasswordResponse(
  opts?: WellKnownOptions["changePassword"],
): WellKnownResponse | null {
  const target = opts?.targetUrl ?? envOptionalString("CHANGE_PASSWORD_URL");
  if (target === undefined || target.length === 0) return null;
  return {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "public, max-age=300",
    },
    body: "",
  };
}

/**
 * Generate a standard `/.well-known/*` response.
 *
 * @param endpoint The well-known endpoint name, without the `/.well-known/` prefix.
 * @param options Optional explicit configuration. When omitted, the helper reads
 * convention environment variables for the selected endpoint.
 * @returns A framework-neutral response descriptor, or `null` when the endpoint
 * is not configured.
 *
 * @example
 * ```ts
 * import { wellKnown } from "@robelest/convex-auth/server";
 *
 * export const GET = () => {
 *   const r = wellKnown("assetlinks.json");
 *   if (r === null) return new Response(null, { status: 404 });
 *   return new Response(r.body, { status: r.status, headers: r.headers });
 * };
 * ```
 */
export function wellKnown(
  endpoint: WellKnownEndpoint,
  options?: WellKnownOptions,
): WellKnownResponse | null {
  return WELL_KNOWN_HANDLERS[endpoint](options);
}

const WELL_KNOWN_HANDLERS: Record<
  WellKnownEndpoint,
  (options?: WellKnownOptions) => WellKnownResponse | null
> = {
  "apple-app-site-association": (options) =>
    appleAppSiteAssociationResponse(options?.appleAppSiteAssociation),
  "assetlinks.json": (options) => assetLinksResponse(options?.assetLinks),
  webauthn: () => webAuthnResponse(),
  "security.txt": (options) => securityTxtResponse(options?.securityTxt),
  "change-password": (options) => changePasswordResponse(options?.changePassword),
};
