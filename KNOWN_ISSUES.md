# Known issues

Consciously deferred limitations, most should be addressed prior to v2 release.

## Rate limiting

Probably all public routes need rate limiting of some sort.

## OAuth component rows are never cleaned up, and `startSignIn` is unauthenticated

Expired authorization requests are only deleted when their state is later
presented (`packages/core/src/oauth/component/provider.ts`), so abandoned
flows accumulate forever.

## Support for custom url schemes (eg., React Native)

`allowedRedirectOrigins` entries must be http(s) origins - custom schemes
(`myapp://`, `exp://`) have a `"null"` origin under the URL standard and are
rejected at setup (`packages/core/src/oauth/component/setup.ts`), so React
Native apps must return via https universal links / app links.
