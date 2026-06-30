import type { Message, MessageFile } from "$lib/types/Message";
import type { EndpointMessage } from "./endpoints";

export async function preprocessMessages(messages: Message[]): Promise<EndpointMessage[]> {
	return Promise.resolve(messages)
		.then((msgs) => normalizeFiles(msgs))
		.then((msgs) => injectClipboardFiles(msgs))
		.then(stripEmptyInitialSystemMessage);
}

async function normalizeFiles(messages: Message[]): Promise<EndpointMessage[]> {
	// Files always arrive inline as base64 (no GridFS in the DB-free server).
	return messages.map((message) => ({
		...message,
		files: (message.files ?? []).filter(
			(file): file is MessageFile & { type: "base64" } => file.type === "base64"
		),
	}));
}

async function injectClipboardFiles(messages: EndpointMessage[]) {
	return Promise.all(
		messages.map((message) => {
			const plaintextFiles = message.files
				?.filter((file) => file.mime === "application/vnd.duo.clipboard")
				.map((file) => Buffer.from(file.value, "base64").toString("utf-8"));

			if (!plaintextFiles || plaintextFiles.length === 0) return message;

			return {
				...message,
				content: `${plaintextFiles.join("\n\n")}\n\n${message.content}`,
				files: message.files?.filter((file) => file.mime !== "application/vnd.duo.clipboard"),
			};
		})
	);
}

/**
 * Remove an initial system message if its content is empty/whitespace only.
 * This prevents sending an empty system prompt to any provider.
 */
function stripEmptyInitialSystemMessage(messages: EndpointMessage[]): EndpointMessage[] {
	if (!messages?.length) return messages;
	const first = messages[0];
	if (first?.from !== "system") return messages;

	const content = first?.content as unknown;
	const isEmpty = typeof content === "string" ? content.trim().length === 0 : false;

	if (isEmpty) {
		return messages.slice(1);
	}

	return messages;
}
