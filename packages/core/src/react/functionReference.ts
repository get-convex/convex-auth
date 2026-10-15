"use client";

import {
  getFunctionName,
  type FunctionReference,
  type FunctionType,
  type FunctionVisibility,
} from "convex/server";
import { useMemo } from "react";

/**
 * Return a function reference that keeps its identity while it names the same
 * function.
 *
 * Generated api objects create a new reference object on each property
 * access, so `api.auth.signIn` is a different object at each render. A hook
 * that puts it in the dependencies of `useCallback` thus returns a new
 * callback at each render, and an effect of the caller that depends on this
 * callback runs again after each render. The memo depends on the function
 * name instead.
 */
export function useStableFunctionReference<
  Reference extends FunctionReference<FunctionType, FunctionVisibility>,
>(reference: Reference): Reference {
  const name = getFunctionName(reference);
  // The name identifies the function, so a reference from an earlier render
  // with the same name calls the same function.
  return useMemo(() => reference, [name]);
}
