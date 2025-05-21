import { sequence } from '@sveltejs/kit/hooks';
import { createConvexAuthHooks, createRouteMatcher } from '@convex-dev/auth/sveltekit/server';
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { redirect, type Handle } from '@sveltejs/kit';

const isSignInPage = createRouteMatcher('/signin');
const isProtectedRoute = createRouteMatcher(['/product{/*rest}']);

const { handleAuth, isAuthenticated: isAuthenticatedPromise } = createConvexAuthHooks({
	convexUrl: PUBLIC_CONVEX_URL,
	verbose: true
});

const authFirstPattern: Handle = async ({ event, resolve }) => {
	const isAuthenticated = await isAuthenticatedPromise(event);

	if (isSignInPage(event.url.pathname) && isAuthenticated) {
		redirect(307, '/product');
	}
	if (isProtectedRoute(event.url.pathname) && !isAuthenticated) {
		redirect(307, `/signin?redirectTo=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}

	return resolve(event);
}

export const handle = sequence(handleAuth, authFirstPattern);
