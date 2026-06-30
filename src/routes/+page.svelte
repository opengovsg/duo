<script lang="ts">
	import { replaceState } from "$app/navigation";
	import { page } from "$app/state";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	import ChatWindow from "$lib/components/chat/ChatWindow.svelte";
	import { ERROR_MESSAGES, error } from "$lib/stores/errors";
	import { useSettingsStore } from "$lib/stores/settings.js";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import { createConversation } from "$lib/utils/createConversation";
	import { findCurrentModel } from "$lib/utils/models";
	import { sanitizeUrlParam } from "$lib/utils/urlParams";
	import { onMount, tick } from "svelte";
	import { loading } from "$lib/stores/loading.js";
	import { loadAttachmentsFromUrls } from "$lib/utils/loadAttachmentsFromUrls";
	import { requireAuthUser } from "$lib/utils/auth";

	let { data } = $props();

	const convsStore = useConversationsStore();

	let hasModels = $derived(Boolean(data.models?.length));
	let files: File[] = $state([]);
	let draft = $state("");

	const settings = useSettingsStore();

	async function startConversation(message: string) {
		try {
			$loading = true;

			// check if $settings.activeModel is a valid model
			// else use the first model
			const validModels = data.models.map((model) => model.id);
			const model = validModels.includes($settings.activeModel)
				? $settings.activeModel
				: data.models[0].id;

			const preprompt =
				($settings.customPromptsEnabled?.[$settings.activeModel] ?? true)
					? $settings.customPrompts[$settings.activeModel]
					: "";

			await createConversation({ message, model, preprompt, files, convsStore });
		} catch (err) {
			error.set((err as Error).message || ERROR_MESSAGES.default);
			console.error(err);
		} finally {
			$loading = false;
		}
	}

	onMount(async () => {
		try {
			// Check if auth is required before processing any query params
			const hasQ = page.url.searchParams.has("q");
			const hasPrompt = page.url.searchParams.has("prompt");
			const hasAttachments = page.url.searchParams.has("attachments");

			if ((hasQ || hasPrompt || hasAttachments) && requireAuthUser()) {
				return; // Redirecting to login, will return to this URL after
			}

			// Handle attachments parameter first
			if (hasAttachments) {
				const result = await loadAttachmentsFromUrls(page.url.searchParams);
				files = result.files;

				// Show errors if any
				if (result.errors.length > 0) {
					console.error("Failed to load some attachments:", result.errors);
					error.set(
						`Failed to load ${result.errors.length} attachment(s). Check console for details.`
					);
				}

				// Clean up URL
				const url = new URL(page.url);
				url.searchParams.delete("attachments");
				history.replaceState({}, "", url);
			}

			const query = sanitizeUrlParam(page.url.searchParams.get("q"));
			if (query) {
				void startConversation(query);
				const url = new URL(page.url);
				url.searchParams.delete("q");
				tick().then(() => {
					replaceState(url, page.state);
				});
				return;
			}

			const promptQuery = sanitizeUrlParam(page.url.searchParams.get("prompt"));
			if (promptQuery && !draft) {
				draft = promptQuery;
				const url = new URL(page.url);
				url.searchParams.delete("prompt");
				tick().then(() => {
					replaceState(url, page.state);
				});
			}
		} catch (err) {
			console.error("Failed to process URL parameters:", err);
		}
	});

	let currentModel = $derived(findCurrentModel(data.models, data.oldModels, $settings.activeModel));
</script>

<svelte:head>
	<title>{publicConfig.PUBLIC_APP_NAME}</title>
</svelte:head>

{#if hasModels}
	<ChatWindow
		onmessage={(message) => startConversation(message)}
		loading={$loading}
		{currentModel}
		models={data.models}
		bind:files
		bind:draft
	/>
{:else}
	<div class="mx-auto my-20 max-w-xl rounded-xl border p-6 text-center dark:border-gray-700">
		<h2 class="mb-2 text-xl font-semibold">No models available</h2>
		<p class="text-gray-600 dark:text-gray-300">
			No chat models are configured. Set `OPENAI_BASE_URL` and ensure the server can reach the
			endpoint, then reload. If unset, the app defaults to the Hugging Face router.
		</p>
	</div>
{/if}
