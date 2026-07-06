import { requireEnv } from "./env";

const DEFAULT_AUTH_PATH = "/auth";

/** @internal */
export function normalizeUrl(url: string) {
  return url.replace(/\/$/, "");
}

/** @internal */
export function normalizeAuthPath(path: string | undefined) {
  if (path === undefined || path.trim() === "") {
    return DEFAULT_AUTH_PATH;
  }
  const trimmed = path.trim();
  if (trimmed === "/") {
    return "";
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/** @internal */
export function authUrl(siteUrl: string, path?: string) {
  return `${normalizeUrl(siteUrl)}${normalizeAuthPath(path)}`;
}

/** @internal */
export function authUrlFromEnv(path?: string) {
  return authUrl(requireEnv("CONVEX_SITE_URL"), path);
}

/** @internal */
export function appUrlFromEnv() {
  return normalizeUrl(requireEnv("APP_URL"));
}

/** @internal */
export function isLocalHost(host?: string) {
  if (host === undefined) {
    return false;
  }
  const raw = host.includes("://") ? host : `http://${host}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}
