import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { UrlDependency } from "$lib/types/UrlDependency";
import type { PageLoad } from "./$types";
import type { Message } from "$lib/types/Message";
import type { DeployedSpace } from "$lib/types/Conversation";
import { conversationRepository } from "$lib/repositories/ConversationRepository";
import { convertLegacyConversation } from "$lib/utils/tree/convertLegacyConversation";
import superjson from "superjson";

// Database-free build: the conversation lives only in the browser's IndexedDB,
// so this page can only render client-side.
export const ssr = false;

interface ConversationData {
	messages: Message[];
	title: string;
	model: string;
	preprompt?: string;
	rootMessageId?: string;
	id: string;
	updatedAt: Date;
	modelId: string;
	shared: boolean;
	deployedSpaces?: Record<string, DeployedSpace>;
}

export const load: PageLoad = async ({ params, depends }) => {
	depends(UrlDependency.Conversation);

	// Read the conversation straight from IndexedDB. There is no server record.
	const cached = await conversationRepository.getConversationDetail(params.id);
	if (!cached) {
		redirect(302, `${base}/`);
	}

	let messages = superjson.parse(cached.messages) as Message[];
	let rootMessageId = cached.rootMessageId;
	// Convert any legacy (rootMessageId-less) conversation to tree form.
	if (!rootMessageId && messages.length > 0) {
		const converted = convertLegacyConversation({
			messages,
			rootMessageId,
			preprompt: cached.preprompt,
		});
		messages = converted.messages;
		rootMessageId = converted.rootMessageId;
	}

	return {
		id: cached.id,
		title: cached.title,
		model: cached.model,
		updatedAt: new Date(cached.updatedAt),
		messages,
		preprompt: cached.preprompt,
		rootMessageId,
		shared: cached.shared,
		modelId: cached.modelId,
	} satisfies ConversationData;
};
