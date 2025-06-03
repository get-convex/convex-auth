import type { PageServerLoad } from './$types';
import { api } from '$lib/convex/_generated/api.js';
import { createConvexAuthHandlers } from '@convex-dev/auth/sveltekit/server';

export const load = (async (event) => {
    const { createConvexHttpClient} = await createConvexAuthHandlers();
    const client = await createConvexHttpClient(event);

    const viewer = await client.query(api.users.viewer, {});
    const messages = await client.query(api.messages.list, {});
    return {
		viewer,
		messages
	};
}) satisfies PageServerLoad;