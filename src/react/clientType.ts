import { ConvexReactClient } from "convex/react";
import { FunctionReference, OptionalRestArgs } from "convex/server";

export type AuthClient = {
  authenticatedCall<Action extends FunctionReference<"action", "public">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<Action["_returnType"]>;
  // These calls don't need to be authenticated
  // and they must not be done over the websocket in case of ConvexReactClient
  unauthenticatedCall<Action extends FunctionReference<"action", "public">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<Action["_returnType"]>;
  verbose: boolean | undefined;
  logger?: ConvexReactClient["logger"];
};
