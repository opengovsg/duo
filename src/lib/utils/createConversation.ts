import { goto } from "$app/navigation";
import { base } from "$app/paths";
import superjson from "superjson";
import { v4 as uuidv4 } from "uuid";

import { conversationRepository } from "$lib/repositories/ConversationRepository";
import { generateObjectId } from "$lib/utils/generateObjectId";
import { storePendingFiles } from "$lib/utils/pendingFiles";
import type { useConversationsStore } from "$lib/stores/conversations.svelte";

type ConversationsStore = ReturnType<typeof useConversationsStore>;

interface CreateConversationOptions {
	/** The first user message; passed to the conversation page via history state. */
	message: string;
	/** Resolved model id for the new conversation. */
	model: string;
	/** Resolved system preprompt (may be empty). */
	preprompt: string;
	/** Attachments for the first message; serialised via a client-side nonce. */
	files: File[];
	/** Sidebar store, used to optimistically prepend the new conversation. */
	convsStore: ConversationsStore;
}

/**
 * Client-state ("DB-free") conversation creation: mint the conversation in the
 * browser, persist it to IndexedDB, optimistically add it to the sidebar, then
 * navigate to it carrying the first message. Shared by the index page and the
 * per-model landing page so both follow the same path (there is no server-side
 * conversation endpoint).
 */
export async function createConversation({
	message,
	model,
	preprompt,
	files,
	convsStore,
}: CreateConversationOptions): Promise<void> {
	const conversationId = generateObjectId();
	const systemMessageId = uuidv4();
	const messages = [
		{
			id: systemMessageId,
			from: "system" as const,
			content: preprompt ?? "",
			createdAt: new Date(),
			updatedAt: new Date(),
			ancestors: [],
			children: [],
		},
	];

	await conversationRepository.setConversationDetail(conversationId, {
		title: "New Chat",
		model,
		updatedAt: new Date().toISOString(),
		messages: superjson.stringify(messages),
		preprompt: preprompt ?? "",
		rootMessageId: systemMessageId,
		shared: false,
		modelId: model,
	});

	// Optimistically prepend the new conversation to the sidebar immediately so
	// it appears before the first message starts streaming. "New Chat" matches
	// the default title; the real title arrives via a Title stream update once
	// the LLM generates one.
	convsStore.prepend({ id: conversationId, title: "New Chat", model, updatedAt: new Date() });

	// Pass the first message text via SvelteKit history state (JSON-serializable).
	// File objects are not serializable, so they are stored in a client-side Map
	// keyed by a random nonce; the nonce travels with the history state and is
	// consumed once by the conversation page.
	const pendingFilesNonce = files.length > 0 ? storePendingFiles(files) : undefined;
	await goto(`${base}/conversation/${conversationId}`, {
		state: { pendingMessage: message, pendingFilesNonce },
	});
}
