<script lang="ts">
	import { useQuery, useConvexClient } from 'convex-svelte';
	import { api } from '$lib/convex/_generated/api';
	import type { Id } from '$lib/convex/_generated/dataModel';
	import Message from './Message.svelte';
	import MessageList from './MessageList.svelte';
	
	interface Props {
		viewer: Id<'users'>;
	}

	let { viewer }: Props = $props();

	const client = useConvexClient();
	
	let newMessageText = $state('');
	
	const messages = useQuery(api.messages.list, {});
	
	async function handleSubmit(event: Event) {
		event.preventDefault();
		if (newMessageText.trim() === '') return;
		
		try {
			await client.mutation(api.messages.send, { body: newMessageText });
			newMessageText = '';
		} catch (error) {
			console.error('Failed to send message:', error);
		}
	}
</script>

<MessageList messages={messages.data}>
	{#if messages.data}
		{#each messages.data as message}
			<Message
				authorName={message.author}
				authorId={message.userId}
				viewerId={viewer}
			>
				{message.body}
			</Message>
		{/each}
	{/if}
</MessageList>

<div class="border-t">
	<form onsubmit={handleSubmit} class="flex gap-2 p-4">
		<input 
			type="text"
			bind:value={newMessageText}
			placeholder="Write a message…"
			class="input"
		/>
		<button 
			type="submit" 
			disabled={newMessageText === ''}
			class="btn preset-filled-pri"
		>
			Send
		</button>
	</form>
</div>
