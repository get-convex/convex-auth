/**
 * Adapted from Clerk's createRouteMatcher (MIT, 2022 Clerk, Inc.)
 * Additional modifications 2025 Convex.
 * 
 * The original licence follows:
 * -----------------------------------------------------------
 * 
 * MIT License
 * 
 * Copyright (c) 2022 Clerk, Inc.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ------------------------------------------------------------
 */

import { match } from "path-to-regexp";
import type Link from "next/link";
import type { NextRequest } from "next/server";

/**
 * Type for route matching paths using path-to-regexp v8.2 syntax.
 * Supports:
 * - Normal paths ('/dashboard')
 * - Parameter paths ('/:id')
 * - Wildcard paths ('/*splat')
 * - Optional segments ('/users{/:id}/profile')
 */
export type PathPattern = string;

/**
 * Base type for Next.js routes - extracts types from the Link component
 */
export type NextTypedRoute<T = Parameters<typeof Link>["0"]["href"]> = T extends string
  ? T
  : never;

/**
 * Parameters that can be passed to createRouteMatcher.
 * Can be a single pattern, an array of patterns, a RegExp, or a custom matcher function.
 */
export type RouteMatcherParam =
  | PathPattern
  | PathPattern[]
  | RegExp
  | ((req: NextRequest) => boolean);

/**
 * Returns a function that accepts a `NextRequest` object and returns whether the request matches the list of
 * predefined routes that can be passed in as the first argument.
 *
 * You can use glob patterns to match multiple routes or a function to match against the request object.
 * Path patterns and limited regular expressions are supported.
 * For more information, see: https://www.npmjs.com/package/path-to-regexp/v/8.2.0
 *
 * Examples:
 * ```ts
 * // Match exact path
 * const isDashboard = createRouteMatcher('/dashboard');
 *
 * // Match with Parameters
 * const isOrgDashboard = createRouteMatcher('/:org/dashboard');
 *
 * // Match with Wildcard
 * const isApi = createRouteMatcher('/api/*');
 *
 * // Match with Optional
 * const isUsersDelete = createRouteMatcher('/users{/:id}/delete');
 *
 * // Match multiple paths
 * const matcher = createRouteMatcher(['/dashboard', '/account', '/api/*']);
 * ```
 */
export const createRouteMatcher = (routes: RouteMatcherParam) => {
  // If routes is a function, use it directly
  if (typeof routes === "function") {
    return (req: NextRequest) => routes(req);
  }

  // If routes is a RegExp, use it directly
  if (routes instanceof RegExp) {
    return (req: NextRequest) => routes.test(req.nextUrl.pathname);
  }

  // Convert routes to an array if it's not already
  const routePatterns = Array.isArray(routes) ? routes : [routes];
  
  // Filter out empty patterns
  const filteredPatterns = routePatterns.filter(Boolean) as Array<
    string | RegExp
  >;
  
  // Create matcher functions for each pattern
  const matchers = filteredPatterns.map((pattern) => {
    if (pattern instanceof RegExp) {
      return (pathname: string) => pattern.test(pathname);
    } else {
      try {
        // Use the match function from path-to-regexp
        const matchFn = match(pattern, { end: true });
        return (pathname: string) => matchFn(pathname) !== false;
      } catch (e: any) {
        throw new Error(
          `Invalid path: ${pattern}.\nConsult the documentation of path-to-regexp here: https://github.com/pillarjs/path-to-regexp\n${e.message}`,
        );
      }
    }
  });

  // Return a function that returns true if any of the matchers return true
  return (req: NextRequest) => 
    matchers.some((matcher) => matcher(req.nextUrl.pathname));
};
