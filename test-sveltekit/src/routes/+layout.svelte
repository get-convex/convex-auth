<script lang="ts">
	import { setupConvexAuth } from '@convex-dev/auth/sveltekit';

	import '../app.css';

	let { children, data } = $props();

	let authState = $state(data.authState);

	setupConvexAuth({
		serverState: authState,
		options: {
			verbose: true
		}
	});
</script>

{@render children()}
