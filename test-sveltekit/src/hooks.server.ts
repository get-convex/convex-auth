import { sequence } from '@sveltejs/kit/hooks';
import { createConvexAuthHooks, createRouteMatcher } from '@convex-dev/auth/sveltekit/server';
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { redirect, type Handle } from '@sveltejs/kit';

const isSignInPage = createRouteMatcher('/signin');
const isProtectedRoute = createRouteMatcher('/product/*path');

const { handleAuth, isAuthenticated } = createConvexAuthHooks({
	convexUrl: PUBLIC_CONVEX_URL,
	verbose: true
});

const authFirstPattern: Handle = async ({ event, resolve }) => {
	if (isSignInPage(event.url.pathname) && (await isAuthenticated(event))) {
		redirect(307, '/product');
	}
	if (isProtectedRoute(event.url.pathname) && !(await isAuthenticated(event))) {
		redirect(307, `/signin?redirectTo=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}

	return resolve(event);
}

export const handle = sequence(handleAuth, authFirstPattern);
