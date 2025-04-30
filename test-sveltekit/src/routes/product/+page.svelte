<script lang="ts">
	import { api } from '$lib/convex/_generated/api';
	import Chat from '$lib/Chat/Chat.svelte';
	import ChatIntro from '$lib/Chat/ChatIntro.svelte';
	import UserMenu from '$lib/UserMenu.svelte';
	import { useQuery } from 'convex-svelte';

	const viewer = useQuery(api.users.viewer, {});
</script>

{#if viewer.data}
<main class="flex max-h-screen grow flex-col overflow-hidden">
	<div class="flex items-start justify-between border-b p-4">
		<ChatIntro />
		<UserMenu data={viewer.data} />
	</div>
	<Chat viewer={viewer.data._id} />
</main>
{/if}

