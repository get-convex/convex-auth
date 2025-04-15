/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
import { 
  createConvexAuthHandlers, 
  createConvexAuthHooks,
  convexAuthSvelteKitServerState
} from './handlers.js';
import { 
  createRouteMatcher, 
  createRouteMatcherGroup,
  type RouteMatcherParam, 
  type RouteMatcherFn 
} from './routeMatcher.js';

// Export server handlers
export {
  createConvexAuthHandlers,
  createConvexAuthHooks,
  convexAuthSvelteKitServerState
};

// Export route matchers (equivalent to NextJS implementation)
export { 
  createRouteMatcher, 
  createRouteMatcherGroup,
  type RouteMatcherParam,
  type RouteMatcherFn
};
