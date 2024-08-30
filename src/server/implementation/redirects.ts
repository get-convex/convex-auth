import { ConvexAuthMaterializedConfig } from "../index.js";
import { requireEnv } from "../utils.js";

export async function redirectAbsoluteUrl(
  config: ConvexAuthMaterializedConfig,
  params: { redirectTo: unknown },
) {
  if (params.redirectTo !== undefined) {
    if (typeof params.redirectTo !== "string") {
      throw new Error(
        `Expected \`redirectTo\` to be a string, got ${params.redirectTo as any}`,
      );
    }
    const redirectCallback =
      config.callbacks?.redirect ?? defaultRedirectCallback;
    return await redirectCallback(params as { redirectTo: string });
  }
  return siteUrl();
}

async function defaultRedirectCallback({ redirectTo }: { redirectTo: string }) {
  const baseUrl = siteUrl();
  if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
    return `${baseUrl}${redirectTo}`;
  }
  if (redirectTo.startsWith(baseUrl)) {
    const after = redirectTo[baseUrl.length];
    if (after === undefined || after === "?" || after === "/") {
      return redirectTo;
    }
  }
  throw new Error(
    `Invalid \`redirectTo\` ${redirectTo} for configured SITE_URL: ${baseUrl.toString()}`,
  );
}

// Temporary work-around because Convex doesn't support
// schemes other than http and https.
export function setURLSearchParam(
  absoluteUrl: string,
  param: string,
  value: string,
) {
  const pattern = /([^:]+):(.*)/;
  const [, scheme, rest] = absoluteUrl.match(pattern)!;
  const hasNoDomain = /^\/\/(?:\/|$|\?)/.test(rest);
  const startsWithPath = hasNoDomain && rest.startsWith("///");
  const url = new URL(
    `http:${hasNoDomain ? "//googblibok" + rest.slice(2) : rest}`,
  );
  url.searchParams.set(param, value);
  const [, , withParam] = url.toString().match(pattern)!;
  return `${scheme}:${hasNoDomain ? (startsWithPath ? "/" : "") + "//" + withParam.slice(13) : withParam}`;
}

function siteUrl() {
  return requireEnv("SITE_URL").replace(/\/$/, "");
}
