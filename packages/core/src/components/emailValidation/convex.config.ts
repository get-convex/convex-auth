import { defineComponent } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

/**
 * The email-validation component.
 *
 * Proves control of an email address before it ever reaches the app's users
 * table. It holds a short-lived validation session per user — the SHA-256 hash
 * of a high-entropy secret (bearer credential) plus the hash of a short code
 * delivered out-of-band by email — keyed only by an opaque `userId`. It knows
 * nothing about the app's users table; confirmation is completed by the caller.
 *
 * Mounts the rate-limiter component to throttle both email sends (per address)
 * and confirmation attempts (per session).
 */
const component = defineComponent("authEmailValidation");
component.use(rateLimiter);

export default component;
