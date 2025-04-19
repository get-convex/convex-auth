<script lang="ts">
	import { goto } from '$app/navigation';

	import { Popover } from '@skeletonlabs/skeleton-svelte';

	import { useAuth } from '@convex-dev/auth/sveltekit';

	interface Props {
		children: import('svelte').Snippet;
	}

	let { children }: Props = $props();

	const { signOut } = useAuth();

	async function handleSignOut() {
		await signOut();
		goto('/');
	}

	let openState = $state(false);

	function popoverClose() {
		openState = false;
	}
</script>

<div class="flex items-center gap-2 text-sm font-medium">
	{@render children()}
	<div class="dropdown dropdown-end">
		<button class="btn btn-sm variant-filled-surface rounded-full" aria-label="user menu">
			<span class="h-5 w-5">👤</span>
			<span class="sr-only">Toggle user menu</span>
		</button>
		<div class="dropdown-menu variant-filled-surface">
			<div class="menu-item-label">{@render children()}</div>
			<div class="menu-item-divider"></div>
			<button class="menu-item" onclick={handleSignOut}>Sign out</button>
		</div>
	</div>
</div>

<div class="flex items-center gap-2 text-sm font-medium">
	{@render children()}
	<Popover
		open={openState}
		onOpenChange={(e) => (openState = e.open)}
		positioning={{ placement: 'top' }}
		triggerBase="btn preset-tonal"
		contentBase="card bg-surface-200-800 p-4 space-y-4 max-w-[320px]"
		arrow
		arrowBackground="!bg-surface-200 dark:!bg-surface-800"
	>
		{#snippet trigger()}<button class="btn btn-sm preset-tonal rounded-full" aria-label="user menu">
				<span class="h-5 w-5">👤</span>
				<span class="sr-only">Toggle user menu</span>
			</button>{/snippet}
		{#snippet content()}
			<div class="px-2 py-1.5 text-sm font-semibold">{@render children()}</div>
			<hr class="hr" />
			<button class="preset-tonal" onclick={handleSignOut}>Sign out</button>
		{/snippet}
	</Popover>
</div>
