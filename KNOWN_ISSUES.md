# Known issues

Consciously deferred limitations, most should be addressed prior to v2 release.

## Rate limiting

Probably all public routes need rate limiting of some sort.

## OAuth component rows are never cleaned up, and `startSignIn` is unauthenticated

Expired authorization requests and tickets are only deleted when their
secret is later presented (`packages/core/src/oauth/component/provider.ts`),
so abandoned flows accumulate forever.

## OAuth sign-in requires a backend with system env vars in components

The oauth component builds its callback URL from `CONVEX_SITE_URL` with its
`httpPrefix` applied (`packages/core/src/oauth/component/provider.ts`), which
components only see on backends with get-convex/convex-backend@64c163a
(self-hosted minimum release `precompiled-2026-07-28-f0d0b8b`, July 28,
2026). Cloud always has it; an older self-hosted backend fails the first
sign-in with an explicit error naming this requirement.

No action item, just here for awareness.

## One pending OAuth flow per storage

The client keeps a single pending-flow key (`flow` in the oauth setup's
scoped storage, `packages/core/src/oauth/client.ts`). Two sign-ins running concurrently in
different tabs overwrite each other, and both fail recoverably (`expired` /
`invalid_flow`); retrying works.

Fix direction: keyed pending flows selected by a non-secret flow id carried
in the redirect URL. The state itself must still never be read from the URL,
preserving the login-CSRF property.

## Support for custom url schemes (eg., React Native)

`allowedRedirectOrigins` entries must be http(s) origins - custom schemes
(`myapp://`, `exp://`) have a `"null"` origin under the URL standard and are
rejected at setup (`packages/core/src/oauth/component/setup.ts`), so React
Native apps must return via https universal links / app links.

React Native also has no page URL for the client to work from: it defines
`window` but no `window.location`. So the startup handler that finishes a flow
from callback params does nothing there, and `signIn` requires an explicit
`redirectTo` (`packages/core/src/oauth/client.ts`). Supporting React Native
properly means deciding what `redirectTo` looks like when it can't be a page
URL.

## OAuth isn't wired into the Next.js client

`ConvexAuthNextjsProvider` builds its `AuthClient` with no ambient sign-ins and
takes no prop for them (`packages/core/src/nextjs/index.tsx`), so `oauth()` is
never registered and the OAuth hooks throw wherever they're used under SSR. The
sign-in api pointed at the auth proxy is already there, so what's missing is the
registration.

## Apple sign-in isn't supported yet

Two gaps. The callback route only accepts GET redirects, and Apple POSTs the
callback (`response_mode=form_post`) whenever name/email scopes are
requested. And Apple has no static client secret: it requires a short-lived
ES256 client-secret JWT, signed with a registered key and rotated, where the
catalogs assume a static `CLIENT_SECRET` binding.

Potential fix direction: accept POST on the callback route
(`packages/core/src/oauth/component/http.ts`), and add a signed-secret
mechanism to the catalog config (`packages/core/src/oauth/component/setup.ts`).

## Refresh-token reuse detection has a bounded horizon

A spent hash is remembered for `SPENT_TOKEN_HORIZON_MS` (1 hour) and pruned by
later rotations of the same session.

Spent rows are pruned inline by the rotations of their own session, so a session
abandoned mid-life leaves its remaining rows behind until it is signed out or
expires — the same way an abandoned session row itself lingers today. Roughly
`horizon ÷ refresh interval` rows, about 60 at the defaults.

Nothing bounds that per-session set independently, and both `pruneSpentTokens`
and `deleteSession` read all of it. At any plausible refresh rate that is a
few dozen rows, but a session refreshed pathologically often (an unthrottled
client, or an attacker hammering `refresh` — see the rate-limiting entry above)
could grow it until those reads exceed the transaction's limits, which would
make the session unrefreshable and un-signoutable. Accepted for now on the
basis that the sweep below lands first.

Fix direction: a `@convex-dev/batch-worker` loop over `spentRefreshTokens` by
`_creationTime`, mirroring `packages/core/src/components/passkey/cleanup.ts`,
to sweep orphans globally and cap the table regardless of any one session's
behavior. Bound its idle probe's range read above (the passkey version's
`gte(cursor)` is unbounded, which would put the whole index tail in the loop's
read set and thrash on OCC at refresh volume).
