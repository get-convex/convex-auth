<script lang="ts">
	import { api } from '$lib/convex/_generated/api';
	import Chat from './Chat/Chat.svelte';
	import ChatIntro from './Chat/ChatIntro.svelte';
	import UserMenu from '../../components/UserMenu.svelte';
	import { useQuery } from 'convex-svelte';

	const viewer = useQuery(api.users.viewer, {});
</script>

{#if viewer.data}
<main class="flex max-h-screen grow flex-col overflow-hidden">
	<div class="flex items-start justify-between border-b p-4">
		<ChatIntro />
		<UserMenu>{viewer.data.name}</UserMenu>
	</div>
	<Chat viewer={viewer.data._id} />
</main>
{/if}

