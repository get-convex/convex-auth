import { ConvexHttpClient } from "convex/browser";
import { env } from "$env/dynamic/public";

// For debug logging
export function logVerbose(message: string, verbose: boolean = false) {
  if (verbose) {
    console.debug(
      `[verbose] ${new Date().toISOString()} [ConvexAuthSvelteKit] ${message}`,
    );
  }
}

// TODO: Ideally this should be moved to convex-auth similar to the react version
/**
 * Options to {@link preloadQuery}, {@link fetchQuery}, {@link fetchMutation} and {@link fetchAction}.
 */
export type SveltekitOptions = {
  /**
   * The JWT-encoded OpenID Connect authentication token to use for the function call.
   */
  token?: string;
  /**
   * The URL of the Convex deployment to use for the function call.
   * Defaults to `process.env.NEXT_PUBLIC_CONVEX_URL`.
   */
  url?: string;

  /**
   * @internal
   */
  adminToken?: string;
  /**
   * Skip validating that the Convex deployment URL looks like
   * `https://happy-animal-123.convex.cloud` or localhost.
   *
   * This can be useful if running a self-hosted Convex backend that uses a different
   * URL.
   *
   * The default value is `false`
   */
  skipConvexDeploymentUrlCheck?: boolean;
};

export function setupClient(options?: SveltekitOptions) {
  const client = new ConvexHttpClient(
    getConvexUrl(options?.url, options?.skipConvexDeploymentUrlCheck ?? false),
  );
  if (options?.token !== undefined) {
    client.setAuth(options.token);
  }
  // TODO: Somehow .adminToken and .setFetchOptions are not available in ConvexHttpClient although it is in the nextjs version
  // if (options.adminToken !== undefined) {
  //     client.setAdminAuth(options.adminToken);
  //   }
  //   client.setFetchOptions({ cache: "no-store" });
  return client;
}

/**
 * Helper to get the Convex URL from environment variables
 * This allows SvelteKit implementations to automatically use the URL
 */
export function getConvexUrl(
  deploymentUrl?: string,
  skipConvexDeploymentUrlCheck?: boolean,
): string {
  let url = deploymentUrl;
  // Check for the SvelteKit environment variable (available in SvelteKit apps)
  if (!url && typeof env.PUBLIC_CONVEX_URL !== "undefined") {
    url = env.PUBLIC_CONVEX_URL;
  }

  // Try to load from process.env if available in the environment
  if (
    !url &&
    typeof process !== "undefined" &&
    process.env &&
    process.env.PUBLIC_CONVEX_URL
  ) {
    url = process.env.PUBLIC_CONVEX_URL;
  }

  if (!url) {
    throw new Error(
      "Convex URL not provided. Either pass convexUrl parameter or set PUBLIC_CONVEX_URL environment variable.",
    );
  }

  if (!skipConvexDeploymentUrlCheck) {
    validateDeploymentUrl(url);
  }
  return url;
}

export function validateDeploymentUrl(deploymentUrl: string) {
  // TODO: react native is not relevant in sveltekit (But maybe in svelte native), so eventually we need to adjust this section
  // Don't use things like `new URL(deploymentUrl).hostname` since these aren't
  // supported by React Native's JS environment
  if (typeof deploymentUrl === "undefined") {
    throw new Error(
      `Client created with undefined deployment address. If you used an environment variable, check that it's set.`,
    );
  }
  if (typeof deploymentUrl !== "string") {
    throw new Error(
      `Invalid deployment address: found ${deploymentUrl as any}".`,
    );
  }
  if (
    !(deploymentUrl.startsWith("http:") || deploymentUrl.startsWith("https:"))
  ) {
    throw new Error(
      `Invalid deployment address: Must start with "https://" or "http://". Found "${deploymentUrl}".`,
    );
  }

  // Most clients should connect to ".convex.cloud". But we also support localhost and
  // custom custom. We validate the deployment url is a valid url, which is the most
  // common failure pattern.
  try {
    new URL(deploymentUrl);
  } catch {
    throw new Error(
      `Invalid deployment address: "${deploymentUrl}" is not a valid URL. If you believe this URL is correct, use the \`skipConvexDeploymentUrlCheck\` option to bypass this.`,
    );
  }

  // If a user uses .convex.site, this is very likely incorrect.
  if (deploymentUrl.endsWith(".convex.site")) {
    throw new Error(
      `Invalid deployment address: "${deploymentUrl}" ends with .convex.site, which is used for HTTP Actions. Convex deployment URLs typically end with .convex.cloud? If you believe this URL is correct, use the \`skipConvexDeploymentUrlCheck\` option to bypass this.`,
    );
  }
}

export function isCorsRequest(request: Request) {
  const origin = request.headers.get("Origin");
  const originURL = origin ? new URL(origin) : null;
  return (
    originURL !== null &&
    (originURL.host !== request.headers.get("Host") ||
      originURL.protocol !== new URL(request.url).protocol)
  );
}
