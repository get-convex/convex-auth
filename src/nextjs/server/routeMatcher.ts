// Adapted from Clerk
//
// MIT License
//
// Copyright (c) 2022 Clerk, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { pathToRegexp } from "path-to-regexp";
import type Link from "next/link";
import type { NextRequest } from "next/server";

type WithPathPatternWildcard<T> = `${T & string}(.*)`;
type NextTypedRoute<T = Parameters<typeof Link>["0"]["href"]> = T extends string
  ? T
  : never;

type Autocomplete<U extends T, T = string> = U | (T & Record<never, never>);

type RouteMatcherWithNextTypedRoutes = Autocomplete<
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  WithPathPatternWildcard<NextTypedRoute> | NextTypedRoute
>;

/**
 * See {@link createRouteMatcher} for more information.
 */
export type RouteMatcherParam =
  | Array<RegExp | RouteMatcherWithNextTypedRoutes>
  | RegExp
  | RouteMatcherWithNextTypedRoutes
  | ((req: NextRequest) => boolean);

/**
 * Returns a function that accepts a `Request` object and returns whether the request matches the list of
 * predefined routes that can be passed in as the first argument.
 *
 * You can use glob patterns to match multiple routes or a function to match against the request object.
 * Path patterns and limited regular expressions are supported.
 * For more information, see: https://www.npmjs.com/package/path-to-regexp/v/6.3.0
 */
export const createRouteMatcher = (routes: RouteMatcherParam) => {
  if (typeof routes === "function") {
    return (req: NextRequest) => routes(req);
  }

  const routePatterns = [routes || ""].flat().filter(Boolean);
  const matchers = precomputePathRegex(routePatterns);
  return (req: NextRequest) =>
    matchers.some((matcher) => matcher.test(req.nextUrl.pathname));
};

const precomputePathRegex = (patterns: Array<string | RegExp>) => {
  return patterns.map((pattern) =>
    pattern instanceof RegExp ? pattern : pathStringToRegExp(pattern),
  );
};

function pathStringToRegExp(path: string) {
  try {
    return pathToRegexp(path);
  } catch (e: any) {
    throw new Error(
      `Invalid path: ${path}.\nConsult the documentation of path-to-regexp here: https://github.com/pillarjs/path-to-regexp\n${e.message}`,
    );
  }
}
