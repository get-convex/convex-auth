# Changelog

## 0.0.74

- Fix to header propagation in Next.js middleware
- Update Password provider to separate password requirement validation from
  custom profile information
  - **Breaking** If using Password with a custom profile to enforce password
    requirements, you must now implement `validatePasswordRequirements`

## 0.0.73

- Update implementation of refresh tokens reuse **Note:** After upgrading to
  this version, downgrading will require migrating the `authRefreshTokens` table
  to drop the `parentRefreshTokenId` field.
- Add configuration for cookie age in Next.js middleware

## 0.0.72

- Upgrade + pin `@auth/core` to 0.36.0 to avoid issues with mismatched types

## 0.0.71

- Fix bug with setting auth cookies on Next.js response

## 0.0.70

- Improve error handling when calling Convex auth functions from Next.js

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
