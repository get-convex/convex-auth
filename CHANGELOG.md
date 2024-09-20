# Changelog

## 0.0.69

- Add a 10s reuse window for refresh tokens

**Note:** After upgrading to this version, downgrading will require migrating
the `authRefreshTokens` table to drop the `firstUsedTime` field.

- Fix exported type for `signIn` from `convexAuth`

## 0.0.68

- [Next.js] Propagate auth cookies in middleware follow up
- Introduce `convexAuth.isAuthenticated()` and `convexAuth.getToken()` in favor
  of `isAuthenticatedNextJs()` and `convexAuthNextJsToken()` for middleware.

## 0.0.67

- [Next.js] Propagate auth cookies in middleware

## 0.0.66

- [Next.js] Match auth routes to proxy to Convex with and without trailing slash

## 0.0.65

- Add verbose logging to Next.js middleware

## 0.0.64

- Fix issue with re-entrant `fetchAccessToken` with a mutex

---

Previous versions are documented in git history.
