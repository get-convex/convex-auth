<script>
	import { useAuth } from '@convex-dev/auth/sveltekit';
	import { goto } from '$app/navigation';
    
	import { env } from '$env/dynamic/public';

	const { signIn } = useAuth();
</script>

<div class="flex min-h-screen w-full">
	<main class="mx-auto my-auto flex flex-col">
		<h2 class="mb-4 text-2xl font-semibold tracking-tight">Sign in or create an account</h2>
		<button class="btn preset-filled" onclick={() => signIn('github', { redirectTo: '/product' })}
			>Sign In with GitHub</button
		>
		{#if env.PUBLIC_E2E_TEST}
			<form
				class="mt-8 flex flex-col gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					const formData = new FormData(event.currentTarget);
					signIn('secret', formData)
						.then(() => {
							goto('/product');
						})
						.catch(() => {
							window.alert('Invalid secret');
						});
				}}
			>
				Test only: Sign in with a secret
				<input
					aria-label="Secret"
					type="text"
					name="secret"
					placeholder="secret value"
					class="input"
				/>
				<button class="btn preset-filled" type="submit"> Sign in with secret </button>
			</form>
		{/if}

		<a class="anchor" href="/">Cancel</a>
	</main>
</div>
