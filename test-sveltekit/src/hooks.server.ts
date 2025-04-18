import { sequence } from '@sveltejs/kit/hooks';
import { createConvexAuthHooks } from '@convex-dev/auth/sveltekit/server';
import { PUBLIC_CONVEX_URL } from '$env/static/public';

// Create auth hooks - explicitly pass the convexUrl from environment variables
const { handleAuth } = createConvexAuthHooks({
  convexUrl: PUBLIC_CONVEX_URL
});

// Apply hooks in sequence
export const handle = sequence(
  handleAuth
);