/**
 * Svelte client type definitions for Convex Auth.
 */

import { FunctionReference, OptionalRestArgs } from "convex/server";

/**
 * Client implementation for authenticating with the Convex backend.
 */
export interface AuthClient {
  /**
   * Makes an authenticated call to a Convex action.
   */
  authenticatedCall<Action extends FunctionReference<"action", "public">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<Action["_returnType"]>;

  /**
   * Makes an unauthenticated call to a Convex action.
   */
  unauthenticatedCall<Action extends FunctionReference<"action", "public">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<Action["_returnType"]>;

  /**
   * Whether to log verbose auth information.
   */
  verbose?: boolean;

  /**
   * Optional logger for Convex operations.
   */
  logger?: {
    logVerbose: (message: string) => void;
  };
}
