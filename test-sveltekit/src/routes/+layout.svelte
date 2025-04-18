<script lang="ts">
	import { setupConvexAuth } from '@convex-dev/auth/sveltekit';
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	
	import '../app.css';

	let { children, data } = $props();

	setupConvexAuth({ serverState: data.authState, convexUrl: PUBLIC_CONVEX_URL });
</script>

{@render children()}
