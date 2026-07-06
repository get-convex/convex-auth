import { httpRouter } from "convex/server";
import { env, httpAction } from "./_generated/server";
import type { OAuthErrorCode } from "../../lib/oauth.js";
import { internal } from "./_generated/api";
import { beginFlow, mintPendingCode } from "./flow.js";
import { exchangeCode } from "./providers.js";

/**
 * The browser-facing transport for the flow. The app mounts this instance
 * with an `httpPrefix` (e.g. `/auth/google`), so on the deployment's
 * `.convex.site` domain these routes become:
 *
 *   GET <prefix>/start?redirectTo=<app path>&challenge=<verifier hash>
 *     — 302 to the provider
 *   GET <prefix>/callback?code&state
 *     — 302 back into the app
 *
 * `challenge` is the SHA-256 of a verifier the client keeps to itself; the
 * app's redeem mutation demands the verifier back, binding the whole flow to
 * the browser that started it (without it, an attacker could complete a flow
 * as themselves and trick a victim's browser into signing in as the attacker).
 *
 * The callback never renders anything: success redirects to
 * `SITE_URL<redirectTo>?code=<one-time code>` (the app exchanges the code for
 * tokens via its `redeemOAuthCode` mutation) and failure redirects with
 * `?error=<code>` instead, so all user-facing UI stays in the app.
 */
const http = httpRouter();

// A client-minted challenge is the hex SHA-256 of the verifier, nothing else.
const CHALLENGE_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The app frontend's origin. `SITE_URL` is treated as an origin — any path on
 * it is ignored when building redirect targets.
 */
function siteOrigin(): string {
  return new URL(env.SITE_URL).origin;
}

/**
 * Only ever redirect within the app site. String-pattern checks are not
 * enough here — URL parsing strips ASCII tab/newline, so e.g. `/\t/evil.com`
 * reads as a path but resolves protocol-relative to `https://evil.com` — so
 * the check is on the *resolved* URL: it must land on the `SITE_URL` origin.
 */
function isSafeRedirectPath(path: string): boolean {
  const origin = siteOrigin();
  return path.startsWith("/") && new URL(path, origin).origin === origin;
}

/** An app-site URL for the browser: `SITE_URL`'s origin + path + one query param. */
function appTarget(
  redirectTo: string,
  param: { code: string } | { error: OAuthErrorCode },
): string {
  const origin = siteOrigin();
  const resolved = new URL(redirectTo, origin);
  // `redirectTo` was validated at `/start`, but this is the last line of
  // defense for the value that actually reaches the Location header: anything
  // that escapes the app origin is clamped to its root.
  const target =
    resolved.origin === origin ? resolved : new URL("/", origin);
  if ("code" in param) {
    target.searchParams.set("code", param.code);
  } else {
    target.searchParams.set("error", param.error);
  }
  return target.toString();
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      // The callback's Location carries the one-time sign-in code; make sure
      // no intermediary caches these responses.
      "Cache-Control": "no-store",
    },
  });
}

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
}

http.route({
  path: "/start",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;

    const redirectTo = params.get("redirectTo") ?? "/";
    if (!isSafeRedirectPath(redirectTo)) {
      return badRequest(
        'redirectTo must be an absolute path within the app, e.g. "/dashboard".',
      );
    }
    const challenge = params.get("challenge");
    if (challenge === null || !CHALLENGE_PATTERN.test(challenge)) {
      return badRequest(
        "challenge must be the hex SHA-256 hash of a verifier held by the client.",
      );
    }
    // The `authenticate` (account-linking) intent is stored end-to-end but not
    // yet redeemable, so starting such a flow is rejected up front rather than
    // after the user has been through the provider.
    const intent = params.get("intent") ?? "session";
    if (intent !== "session") {
      return badRequest('intent must be "session".');
    }

    const { url } = await beginFlow(ctx, { intent, redirectTo, challenge });
    return redirect(url);
  }),
});

http.route({
  path: "/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;
    const state = params.get("state");
    const code = params.get("code");
    const providerError = params.get("error");

    // Anything short of a clean `code` + `state` pair ends the flow with an
    // error redirect. The state row (when one exists) is still consumed so
    // the browser lands back where the flow started.
    if (providerError !== null || code === null || state === null) {
      const stored =
        state === null
          ? null
          : await ctx.runMutation(internal.model.consumeState, { state });
      const error: OAuthErrorCode =
        providerError !== null ? "access_denied" : "invalid_state";
      if (providerError !== null) {
        console.error(`OAuth provider returned an error: ${providerError}`);
      }
      return redirect(appTarget(stored?.redirectTo ?? "/", { error }));
    }

    const stored = await ctx.runMutation(internal.model.consumeState, {
      state,
    });
    if (!stored) {
      return redirect(appTarget("/", { error: "invalid_state" }));
    }

    try {
      const claims = await exchangeCode({
        code,
        codeVerifier: stored.codeVerifier,
      });
      const oneTimeCode = await mintPendingCode(ctx, {
        claims,
        intent: stored.intent,
        challenge: stored.challenge,
      });
      return redirect(appTarget(stored.redirectTo, { code: oneTimeCode }));
    } catch (e) {
      console.error("OAuth code exchange failed:", e);
      return redirect(
        appTarget(stored.redirectTo, { error: "exchange_failed" }),
      );
    }
  }),
});

export default http;
