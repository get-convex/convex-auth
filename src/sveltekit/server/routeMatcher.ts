/**
 * Route matcher for SvelteKit to match paths for protection
 */

// Types for route matching
export type RouteMatcherParam = string | RegExp | RouteMatcherFn;
export type RouteMatcherFn = (pathname: string) => boolean;

/**
 * Create a route matcher that checks if a route matches the given pattern
 * 
 * @param pattern A string, regex, or function to match against routes
 * @returns A function that returns true if the route matches
 * 
 * Examples:
 * ```ts
 * // Match exact path
 * const matcher = createRouteMatcher('/dashboard');
 * 
 * // Match with regex
 * const matcher = createRouteMatcher(/^\/api\/.*$/);
 * 
 * // Match with function
 * const matcher = createRouteMatcher((path) => path.startsWith('/account'));
 * ```
 */
export function createRouteMatcher(pattern: RouteMatcherParam): RouteMatcherFn {
  if (typeof pattern === 'string') {
    return (pathname) => pathname === pattern;
  }
  
  if (pattern instanceof RegExp) {
    return (pathname) => pattern.test(pathname);
  }
  
  if (typeof pattern === 'function') {
    return pattern;
  }
  
  throw new Error('Invalid route matcher pattern');
}

/**
 * Create a matcher that combines multiple patterns with OR logic
 */
export function createRouteMatcherGroup(patterns: RouteMatcherParam[]): RouteMatcherFn {
  const matchers = patterns.map(pattern => createRouteMatcher(pattern));
  
  return (pathname) => {
    return matchers.some(matcher => matcher(pathname));
  };
}
