<script>
	import { useAuth } from '@convex-dev/auth/sveltekit';

	const auth = useAuth();
</script>

<div class="flex min-h-[50vh] flex-col items-center justify-center gap-4">
	{#if auth.isAuthenticated}
		<p>You are authenticated!</p>
		<a href="/product" class="btn preset-filled-primary-500">Product</a>
		<button onclick={() => auth.signOut()} class="btn preset-tonal">Sign Out</button>
	{:else}
		<p>You are not authenticated.</p>
		<a href="/signin" class="btn preset-filled-primary-500">Sign In</a>
	{/if}
</div>
