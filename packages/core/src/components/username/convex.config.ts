import { defineComponent } from "convex/server";

/**
 * The username component.
 *
 * The component owns the mapping between a username and an opaque app
 * `userId`. It stores one username for each user, and makes sure that no
 * two users have the same username.
 *
 * The component is not an auth provider. It knows nothing about
 * credentials or sessions. An auth provider (for example the password
 * provider) uses it to find the user that a username identifies.
 *
 * The component has no configuration.
 */
const component = defineComponent("authUsername");

export default component;
