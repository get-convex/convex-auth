<script>
	import { useAuth } from '@convex-dev/auth/sveltekit';

	const { signOut } = useAuth();
	const isAuthenticated = $derived(useAuth().isAuthenticated);
</script>

<div class="flex min-h-[50vh] flex-col items-center justify-center gap-4">
	{#if isAuthenticated}
		<p>You are authenticated!</p>
		<a href="/product" class="btn preset-filled-primary-500">Product</a>
		<button onclick={() => signOut()} class="btn preset-tonal">Sign Out</button>
	{:else}
		<p>You are not authenticated.</p>
		<a href="/signin" class="btn preset-filled-primary-500">Get Started</a>
	{/if}
</div>
