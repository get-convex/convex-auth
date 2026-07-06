import { GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError } from "convex/values";

import { ErrorCode } from "../shared/codes";
import { ConvexAuthMaterializedConfig } from "./types";
import { appUrlFromEnv, normalizeUrl } from "./url";

const describeUnknown = (value: unknown) => {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null
  ) {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json ?? Object.prototype.toString.call(value);
};

/**
 * Resolve a sign-in `redirectTo` param to an absolute URL.
 *
 * Relative paths (`/`, `?`) resolve against `APP_URL`. Absolute URLs are
 * accepted only when they target the `APP_URL` origin. Any other absolute URL
 * is rejected and falls back to `APP_URL`, so a crafted `redirectTo` cannot turn
 * the auth origin into an open redirect that leaks the sign-in code. Falls back
 * to `APP_URL` when `redirectTo` is omitted.
 *
 * @throws ConvexError `INVALID_REDIRECT` when `redirectTo` is not a string.
 * @internal
 */
export async function redirectAbsoluteUrl(
  _ctx: GenericActionCtx<GenericDataModel>,
  _config: ConvexAuthMaterializedConfig,
  params: { redirectTo: unknown },
) {
  if (params.redirectTo === undefined) {
    return normalizeUrl(appUrlFromEnv());
  }
  if (typeof params.redirectTo !== "string") {
    throw new ConvexError({
      code: ErrorCode.INVALID_REDIRECT,
      message: `Expected \`redirectTo\` to be a string, got ${describeUnknown(params.redirectTo)}`,
    });
  }
  const redirectTo = params.redirectTo;
  try {
    return defaultRedirectCallback({ redirectTo });
  } catch {
    throw new ConvexError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "An unexpected error occurred.",
    });
  }
}

function defaultRedirectCallback({ redirectTo }: { redirectTo: string }) {
  const siteUrl = normalizeUrl(appUrlFromEnv());
  if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
    return `${siteUrl}${redirectTo}`;
  }
  return isAllowedAbsoluteRedirect(siteUrl, redirectTo) ? redirectTo : siteUrl;
}

function isAllowedAbsoluteRedirect(siteUrl: string, redirectTo: string) {
  let target: URL | null = null;
  try {
    target = new URL(redirectTo);
  } catch {
    target = null;
  }
  return (
    target !== null &&
    (target.protocol === "http:" || target.protocol === "https:") &&
    target.origin === new URL(siteUrl).origin
  );
}

/**
 * Set a query parameter on an absolute URL of any scheme.
 *
 * Works around the Convex runtime's `URL` only supporting `http`/`https`: the
 * scheme is split off, the parameter set on an `http`-normalized URL, then the
 * original scheme is restored.
 *
 * @internal
 */
export function setURLSearchParam(absoluteUrl: string, param: string, value: string) {
  const pattern = /([^:]+):(.*)/;
  const schemeMatch = absoluteUrl.match(pattern);
  if (!schemeMatch) {
    throw new ConvexError({
      code: ErrorCode.INVALID_REDIRECT,
      message: "Redirect URL is missing a scheme.",
    });
  }
  const [, scheme, rest] = schemeMatch;
  const hasNoDomain = /^\/\/(?:\/|$|\?)/.test(rest);
  const startsWithPath = hasNoDomain && rest.startsWith("///");
  const url = new URL(`http:${hasNoDomain ? "//googblibok" + rest.slice(2) : rest}`);
  url.searchParams.set(param, value);
  const withParamMatch = url.toString().match(pattern);
  if (!withParamMatch) {
    throw new ConvexError({
      code: ErrorCode.INVALID_REDIRECT,
      message: "Internal URL serialization produced a malformed result.",
    });
  }
  const [, , withParam] = withParamMatch;
  return `${scheme}:${hasNoDomain ? (startsWithPath ? "/" : "") + "//" + withParam.slice(13) : withParam}`;
}
