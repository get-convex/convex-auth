<script lang="ts">
	import '../app.css';
	import { createSvelteKitAuthProvider } from '@convex-dev/auth/sveltekit';

	let { children, data } = $props();

	const AuthProvider = createSvelteKitAuthProvider();
</script>

<AuthProvider serverState={data.authState}>
	{@render children()}
</AuthProvider>
