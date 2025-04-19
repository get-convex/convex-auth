<script lang="ts">
	import { goto } from '$app/navigation';
	import { useAuth } from '@convex-dev/auth/sveltekit';
	
	export let username: string;
	
	const { signOut } = useAuth();
	
	async function handleSignOut() {
		await signOut();
		goto('/');
	}
</script>

<div class="flex items-center gap-2 text-sm font-medium">
	{username}
	<div class="dropdown dropdown-end">
		<button class="btn btn-sm variant-filled-surface rounded-full" aria-label="user menu">
			<span class="h-5 w-5">👤</span>
			<span class="sr-only">Toggle user menu</span>
		</button>
		<div class="dropdown-menu variant-filled-surface">
			<div class="menu-item-label">{username}</div>
			<div class="menu-item-divider"></div>
			<button class="menu-item" on:click={handleSignOut}>Sign out</button>
		</div>
	</div>
</div>
