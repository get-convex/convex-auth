# Known issues

Consciously deferred limitations, most should be addressed prior to v2 release.

## Rate limiting

Probably all public routes need rate limiting of some sort.

## OAuth component rows are never cleaned up, and `startSignIn` is unauthenticated

Expired authorization requests and tickets are only deleted when their
secret is later presented (`packages/core/src/oauth/component/provider.ts`),
so abandoned flows accumulate forever.

## OAuth sign-in requires a backend with system env vars in components

The oauth component builds its callback URL from its mount-prefixed
`CONVEX_SITE_URL` (`packages/core/src/oauth/component/provider.ts`), which
components only see on backends with get-convex/convex-backend@64c163a
(self-hosted minimum release `precompiled-2026-07-28-f0d0b8b`, July 28,
2026). Cloud always has it; an older self-hosted backend fails the first
sign-in with an explicit error naming this requirement.

No action item, just here for awareness.

## Support for custom url schemes (eg., React Native)

`allowedRedirectOrigins` entries must be http(s) origins - custom schemes
(`myapp://`, `exp://`) have a `"null"` origin under the URL standard and are
rejected at setup (`packages/core/src/oauth/component/setup.ts`), so React
Native apps must return via https universal links / app links.
