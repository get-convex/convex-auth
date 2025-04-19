<script>
	import { useAuth } from '@convex-dev/auth/sveltekit';

	const { signIn, signOut, isAuthenticated } = useAuth();
</script>

<h1>Welcome to SvelteKit</h1>
<p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation</p>

<div>
	{#if isAuthenticated}
		<p>You are authenticated!</p>
		<button onclick={() => signOut()}>Sign Out</button>
	{:else}
		<p>You are not authenticated.</p>
		<button class="btn preset-filled" onclick={() => signIn('google')}>Sign In with Google</button>
	{/if}
</div>
