import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import type { LayoutServerLoad } from './$types';

// Create auth handlers - convexUrl is automatically detected from environment 
const { loadAuthState } = createConvexAuthHandlers();

// Export load function to provide auth state to layout
export const load: LayoutServerLoad = async (event) => {
  return loadAuthState(event);
};