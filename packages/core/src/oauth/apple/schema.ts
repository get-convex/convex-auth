import { defineSchema, defineTable } from "convex/server";
import { authorizationRequestFields, ticketFields } from "../shared/schema.ts";

export default defineSchema({
  /**
   * In-flight authorization requests, created at sign-in and consumed by the
   * Apple callback. Only the state of the flow is kept: everything about
   * Apple itself is a constant in this component (see constants.ts).
   */
  authorizationRequests: defineTable(authorizationRequestFields).index(
    "stateHash",
    ["stateHash"],
  ),

  /**
   * One-time redeemable proof that Apple authenticated the user. Minted by
   * the callback after the code exchange, redeemed exactly once by a caller
   * presenting the raw ticket code plus the original client state. Nothing
   * user-visible (accounts, users, sessions) is created until redemption.
   *
   * The encrypted payload holds `{ claims, callbackParams }`. `claims` are
   * the validated id_token claims, which came from Apple over TLS.
   * `callbackParams` holds the name Apple relays through the browser on a
   * first sign-in, which is user-controlled and is sanitized before it goes
   * in here.
   */
  tickets: defineTable(ticketFields).index("ticketCodeHash", [
    "ticketCodeHash",
  ]),
});
