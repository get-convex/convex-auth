<script lang="ts">
	import type { Id } from '$lib/convex/_generated/dataModel';

	interface Props {
		authorId: Id<'users'>;
		authorName: string;
		viewerId: Id<'users'>;
		children: import('svelte').Snippet;
	}

	let {
		authorId,
		authorName,
		viewerId,
		children
	}: Props = $props();
</script>

<li class="flex flex-col text-sm {authorId === viewerId ? 'items-end self-end' : 'items-start self-start'}">
	<div class="mb-1 text-sm font-medium">{authorName}</div>
	<p class="rounded-xl bg-surface-200-800 px-3 py-2 {authorId === viewerId ? 'rounded-tr-none' : 'rounded-tl-none'}">
		{@render children()}
	</p>
</li>
