<script lang="ts">
	import '../app.css';
	import { setupConvexAuth } from '@convex-dev/auth/sveltekit';

	let { children, data } = $props();

	setupConvexAuth({ serverState: data.authState });
</script>

{@render children()}
