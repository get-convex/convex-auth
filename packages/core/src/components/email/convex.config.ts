import { defineComponent } from "convex/server";

/**
 * The email component.
 *
 * Tracks the verified email addresses of users, keyed only by an opaque
 * `userId`. An email address goes into this component only after the user
 * proves ownership of it. The app owns the users table and maps its own
 * identifiers onto the `userId` it passes in.
 */
const component = defineComponent("authEmail");

export default component;
