import { defineComponent } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

/**
 * The email component.
 *
 * Tracks the verified email addresses of users, keyed only by an opaque
 * `userId`. An email address goes into this component only after the user
 * proves ownership of it through the challenge. The app owns the users
 * table and maps its own identifiers onto the `userId` it passes in.
 *
 * Mounts the rate-limiter component to throttle the `start` mutations per
 * destination address and per client IP.
 */
const component = defineComponent("authEmail");
component.use(rateLimiter);

export default component;
