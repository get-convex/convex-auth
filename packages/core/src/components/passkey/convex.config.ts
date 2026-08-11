import { defineComponent } from "convex/server";

/**
 * The passkey (WebAuthn) provider component.
 *
 * The component owns the `passkeys` credential table and the short-lived
 * `challenges` table. It examines registrations and authentications on the
 * server. It stores credentials with an opaque `userId` only: the app owns
 * the users table.
 *
 * The component has no configuration. The app passes the relying party ID
 * and the origin as arguments to `finishRegistration` and
 * `finishAuthentication`.
 */
const component = defineComponent("authPasskey");

export default component;
