import { auth } from "@/src/lib/serverAuth";

// One catch-all route serves every auth endpoint: refresh, signout, and the
// sign-in routes registered via `providers` in serverAuth.ts. The handler
// dispatches on the request's pathname.
export const POST = auth.handler;
