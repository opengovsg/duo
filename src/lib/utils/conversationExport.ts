/**
 * Conversation export / import for client-state ("DB-free") mode.
 *
 * Sharing (the public /r/[id] link) needs a server-side record, so it is disabled
 * when state lives in the browser. These helpers are the portability substitute:
 * download conversations as a JSON file and re-import them on another browser.
 */
import { browser } from "$app/environment";
import superjson from "superjson";
import type { Message } from "$lib/types/Message";
import { conversationRepository } from "$lib/repositories/ConversationRepository";
import { generateObjectId } from "$lib/utils/generateObjectId";

const EXPORT_VERSION = 1;

interface ExportedConversation {
	id: string;
	title: string;
	model: string;
	modelId: string;
	updatedAt: string;
	preprompt?: string;
	rootMessageId?: string;
	messages: Message[];
}

interface ExportBundle {
	app: "chat-ui";
	version: number;
	exportedAt: string;
	conversations: ExportedConversation[];
}

async function buildExport(ids: string[]): Promise<ExportBundle> {
	const conversations: ExportedConversation[] = [];
	for (const id of ids) {
		const detail = await conversationRepository.getConversationDetail(id);
		if (!detail) continue;
		conversations.push({
			id: detail.id,
			title: detail.title,
			model: detail.model,
			modelId: detail.modelId,
			updatedAt: detail.updatedAt,
			preprompt: detail.preprompt,
			rootMessageId: detail.rootMessageId,
			messages: superjson.parse(detail.messages) as Message[],
		});
	}
	return {
		app: "chat-ui",
		version: EXPORT_VERSION,
		exportedAt: new Date().toISOString(),
		conversations,
	};
}

function download(bundle: ExportBundle, filename: string) {
	const blob = new Blob([superjson.stringify(bundle)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

/** Download a single conversation as a JSON file. */
export async function exportConversation(id: string): Promise<void> {
	if (!browser) return;
	download(await buildExport([id]), `chat-ui-conversation-${id}.json`);
}

/** Download every locally-stored conversation as a single JSON file. */
export async function exportAllConversations(): Promise<void> {
	if (!browser) return;
	const list = await conversationRepository.getConversations();
	download(await buildExport(list.map((c) => String(c.id))), "chat-ui-conversations.json");
}

/**
 * Import conversations from an export file into IndexedDB. Each conversation is
 * given a fresh id so an import never clobbers an existing conversation.
 * Returns the number of conversations imported. The caller should re-seed the
 * sidebar store afterwards (e.g. convsStore.initFromCache()).
 */
export async function importConversationsFromFile(file: File): Promise<{ imported: number }> {
	if (!browser) return { imported: 0 };
	const bundle = superjson.parse(await file.text()) as ExportBundle;
	if (!bundle || bundle.app !== "chat-ui" || !Array.isArray(bundle.conversations)) {
		throw new Error("Not a valid chat-ui export file");
	}

	let imported = 0;
	for (const conv of bundle.conversations) {
		const newId = generateObjectId();
		await conversationRepository.setConversationDetail(newId, {
			title: conv.title,
			model: conv.model,
			modelId: conv.modelId ?? conv.model,
			updatedAt: conv.updatedAt ?? new Date().toISOString(),
			messages: superjson.stringify(conv.messages),
			preprompt: conv.preprompt,
			rootMessageId: conv.rootMessageId,
			shared: false,
		});
		imported++;
	}
	return { imported };
}
