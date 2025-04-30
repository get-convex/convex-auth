<script lang="ts">
	import { goto } from '$app/navigation';

	import { Avatar, Popover } from '@skeletonlabs/skeleton-svelte';

	import { useAuth } from '@convex-dev/auth/sveltekit';
	import type { Id } from '$lib/convex/_generated/dataModel.js';

	interface Props {
		data: {
			_id: Id<'users'>;
			_creationTime: number;
			name?: string | undefined | undefined;
			email?: string | undefined | undefined;
			phone?: string | undefined | undefined;
			image?: string | undefined | undefined;
			emailVerificationTime?: number | undefined | undefined;
			phoneVerificationTime?: number | undefined | undefined;
			isAnonymous?: boolean | undefined | undefined;
		};
	}

	let { data }: Props = $props();

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
	<Popover
		open={openState}
		onOpenChange={(e) => (openState = e.open)}
		positioning={{ placement: 'top' }}
		triggerBase="btn"
		contentBase="card bg-surface-200-800 p-4 space-y-4 max-w-[320px]"
		arrow
		arrowBackground="!bg-surface-200 dark:!bg-surface-800"
	>
		{#snippet trigger()}
			<Avatar src={data.image} name={data.name ?? 'User'} size="size-10" />
		{/snippet}
		{#snippet content()}
			<div class="px-2 py-1.5 text-sm font-semibold">{data.name}</div>
			<hr class="hr" />
			<button class="btn preset-tonal w-full" onclick={handleSignOut}>Sign out</button>
		{/snippet}
	</Popover>
</div>
