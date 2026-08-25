import { defineComponent } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

/**
 * The email component.
 *
 * Tracks the verified email addresses of users, keyed only by an opaque
 * `userId`. An email address goes into this component only after the user
 * proves ownership of it through the challenge. The app owns the users
 * table and maps its own identifiers onto the `userId` it passes in.
 *
 * Mounts the rate-limiter component to throttle the `start` mutations per
 * destination address and per client IP, and the batch worker component,
 * which runs the background loop that erases the expired challenges (see
 * cleanup.ts).
 */
const component = defineComponent("authEmail");
component.use(rateLimiter);
component.use(batchWorker);

export default component;
