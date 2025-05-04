import type { PageServerLoad } from './$types';
import { ConvexHttpClient } from 'convex/browser';
import { PUBLIC_CONVEX_URL } from '$env/static/public';
import { api } from '$lib/convex/_generated/api.js';
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';

export const load = (async (event) => {
    const auth = await createConvexAuthHandlers();
    const state = await auth.getAuthState(event);

    const client = new ConvexHttpClient(PUBLIC_CONVEX_URL);
    client.setAuth(state._state.token!)
    
    const viewer = await client.query(api.users.viewer, {});
    const messages = await client.query(api.messages.list, {});
    return {
		viewer,
		messages
	};
}) satisfies PageServerLoad;