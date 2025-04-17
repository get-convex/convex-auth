import { sequence } from '@sveltejs/kit/hooks';
import { createConvexAuthHooks } from '@convex-dev/auth/sveltekit/server';

// Create auth hooks - convexUrl is automatically detected from environment
const { handleAuth } = createConvexAuthHooks();

// Apply hooks in sequence
export const handle = sequence(
  handleAuth
);