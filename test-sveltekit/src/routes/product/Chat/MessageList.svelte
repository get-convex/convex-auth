<script lang="ts">
	interface Props {
		messages: unknown;
		children?: import('svelte').Snippet;
	}

	let { messages, children }: Props = $props();
	let listEl: HTMLOListElement;

	$effect(() => {
		messages;

		if (listEl) {
			listEl.scrollTo({
				top: listEl.scrollHeight,
				behavior: 'smooth'
			});
		}
	});
</script>

<ol bind:this={listEl} class="flex grow flex-col gap-4 overflow-y-auto scroll-smooth px-8 py-4">
	{@render children?.()}
</ol>
