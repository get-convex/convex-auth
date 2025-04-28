import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';
import type { LayoutServerLoad } from './$types';
import { PUBLIC_CONVEX_URL } from '$env/static/public';

// Create auth handlers - explicitly pass the convexUrl from environment variables
const { getAuthState } = createConvexAuthHandlers({
  convexUrl: PUBLIC_CONVEX_URL
});

// Export load function to provide auth state to layout
export const load: LayoutServerLoad = async (event) => {
  return { authState: await getAuthState(event) };
};