import { auth } from "@/src/lib/serverAuth";

// The SSR auth proxy. It proxies the auth sign-in routes set up in serverAuth.ts, forwarding each call to the deployment. Instead of sending all resulting tokens as part of the response body (as calling the Convex function directly would do), the proxy moves the minted refresh token into an httpOnly cookie on the way back.
//
// Adding an auth method means adding its function to that allowlist. There is
// no per-method route or client code.
export const POST = auth.proxyHandler;
