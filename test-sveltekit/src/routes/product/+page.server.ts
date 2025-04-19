import { api } from '../../../convex/_generated/api';
import { createConvexAuthHooks } from '@convex-dev/auth/sveltekit/server';
import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { PUBLIC_CONVEX_URL } from '$env/static/public';

// Create Convex auth hooks
const { isAuthenticated } = createConvexAuthHooks({
	convexUrl: PUBLIC_CONVEX_URL
});

export const load: PageServerLoad = async (event) => {
	// Check if the user is authenticated
	if (!(await isAuthenticated(event))) {
		throw redirect(307, '/signin');
	}
	
	// The auth token is automatically picked up by the Convex client in the browser
	return {
		// Return an empty viewer object - the actual data will be fetched client-side
		// where Convex client is already configured with auth
		viewer: {}
	};
};
