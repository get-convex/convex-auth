import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';

const { isAuthenticated: isAuthenticatedPromise } = createConvexAuthHandlers();

export const GET: RequestHandler = async (event) => {
	const isAuthenticated = await isAuthenticatedPromise(event);
	// return new Response();
	return json({ someData: isAuthenticated }, { status: isAuthenticated ? 200 : 403 });
};
