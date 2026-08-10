import { auth } from "@/src/lib/serverAuth";

// The auth proxy, mounted once. It serves the `ConvexHttpClient` endpoints
// (/auth/api/mutation, /auth/api/action) for every provider listed in
// `signIn` in serverAuth.ts, forwarding each call to the deployment and moving
// the minted refresh token into an httpOnly cookie on the way back.
//
// Adding an auth method means adding its function to that allowlist. There is
// no per-method route or client code.
export const POST = auth.proxyHandler;
