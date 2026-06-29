import { config } from "$lib/server/config";
import { loginEnabled } from "$lib/server/auth";
import { models } from "$lib/server/models";
import type { Message } from "$lib/types/Message";
import type { Conversation } from "$lib/types/Conversation";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	MessageReasoningUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { isMessageId } from "$lib/utils/tree/isMessageId";
import { usageLimits } from "$lib/server/usageLimits";
import { textGeneration } from "$lib/server/textGeneration";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";
import { logger } from "$lib/server/logger.js";
import { MetricsServer } from "$lib/server/metrics";
import { stripReasoningBlocks } from "$lib/server/textGeneration/utils/routing";

/**
 * Stateless generation endpoint. The browser owns the conversation tree and sends
 * the prompt context; the server generates and persists NOTHING. Identity comes
 * from the sealed session cookie (when login is enabled).
 */
export async function POST({ request, locals, params, getClientAddress }) {
	const id = z.string().parse(params.id);
	const convId = new ObjectId(id);
	const promptedAt = new Date();

	if (loginEnabled && !locals.user) {
		error(401, "Unauthorized");
	}

	const form = await request.formData();
	const json = form.get("data");
	if (!json || typeof json !== "string") {
		error(400, "Invalid request");
	}

	const {
		selectedMcpServerNames,
		selectedMcpServers,
		timezone,
		model: clientModel,
		messages: clientMessages,
		overrides: clientOverrides,
	} = z
		.object({
			id: z.string().uuid().refine(isMessageId).optional(),
			generationId: z.string().uuid().optional(),
			inputs: z.optional(z.string()),
			is_retry: z.optional(z.boolean()),
			is_continue: z.optional(z.boolean()),
			selectedMcpServerNames: z.optional(z.array(z.string())),
			selectedMcpServers: z
				.optional(
					z.array(
						z.object({
							name: z.string(),
							url: z.string(),
							headers: z
								.optional(z.array(z.object({ key: z.string(), value: z.string() })))
								.default([]),
						})
					)
				)
				.default([]),
			timezone: z.optional(z.string()),
			model: z.string(),
			messages: z.array(z.record(z.string(), z.unknown())).min(1),
			overrides: z.optional(
				z.object({
					forceMultimodal: z.optional(z.boolean()),
					forceTools: z.optional(z.boolean()),
					provider: z.optional(z.string()),
					reasoningEffort: z.optional(z.enum(["low", "medium", "high"])),
					artifactsOverride: z.optional(z.boolean()),
					billingOrganization: z.optional(z.string()),
				})
			),
		})
		.parse(JSON.parse(json));

	// Attach MCP selection to locals so the text generation pipeline can consume it
	try {
		(locals as unknown as Record<string, unknown>).mcp = {
			selectedServerNames: selectedMcpServerNames,
			selectedServers: (selectedMcpServers ?? []).map((s) => ({
				name: s.name,
				url: s.url,
				headers:
					s.headers && s.headers.length > 0
						? Object.fromEntries(s.headers.map((h) => [h.key, h.value]))
						: undefined,
			})),
		};
	} catch {
		// ignore attachment errors, pipeline will just use env servers
	}

	if (timezone) {
		(locals as unknown as Record<string, unknown>).timezone = timezone;
	}

	const model = models.find((m) => m.id === clientModel);
	if (!model) {
		error(410, "Model not available anymore");
	}

	const messagesForPrompt = clientMessages as unknown as Message[];

	// Reject oversized inline (base64) attachments (~10MB raw -> ~14MB base64).
	for (const message of messagesForPrompt) {
		for (const file of message.files ?? []) {
			if (file.type === "base64" && file.value.length > 14 * 1024 * 1024) {
				error(413, "File too large, should be <10MB");
			}
		}
	}

	if (usageLimits?.messageLength) {
		const lastUser = [...messagesForPrompt].reverse().find((m) => m.from === "user");
		if ((lastUser?.content?.length ?? 0) > usageLimits.messageLength) {
			error(400, "Message too long.");
		}
	}

	const systemMessage = messagesForPrompt[0]?.from === "system" ? messagesForPrompt[0] : undefined;

	const conv = {
		_id: convId,
		model: model.id,
		title: "New Chat",
		rootMessageId: messagesForPrompt[0]?.id,
		messages: messagesForPrompt,
		preprompt: systemMessage?.content ?? model.preprompt ?? "",
		createdAt: promptedAt,
		updatedAt: promptedAt,
	} as Conversation;

	// throwaway assistant message the streaming closure accumulates into; never
	// persisted (the browser applies the same updates to its own copy).
	const messageToWriteTo: Message = {
		id: uuidv4(),
		from: "assistant",
		content: "",
		createdAt: new Date(),
		updatedAt: new Date(),
		updates: [],
	};

	let clientDetached = false;
	let streamAbortController: AbortController | undefined;

	let lastTokenTimestamp: undefined | Date = undefined;
	let firstTokenObserved = false;
	const metricsEnabled = MetricsServer.isEnabled();
	const metrics = metricsEnabled ? MetricsServer.getMetrics() : undefined;
	const metricsLabels = { model: model.id ?? model.name ?? conv.model };

	const stream = new ReadableStream({
		async start(controller) {
			const ctrl = new AbortController();
			streamAbortController = ctrl;

			let finalAnswerReceived = false;
			let abortedByUser = false;
			let finishedStatusSent = false;

			const initialMessageContent = messageToWriteTo.content;

			async function update(event: MessageUpdate) {
				if (
					event.type === MessageUpdateType.Status &&
					event.status === MessageUpdateStatus.Finished
				) {
					finishedStatusSent = true;
				}

				if (event.type === MessageUpdateType.Stream) {
					if (event.token === "") return;
					messageToWriteTo.content += event.token;

					if (metricsEnabled && metrics) {
						const now = Date.now();
						metrics.model.tokenCountTotal.inc(metricsLabels);
						if (!firstTokenObserved) {
							metrics.model.timeToFirstToken.observe(metricsLabels, now - promptedAt.getTime());
							firstTokenObserved = true;
						}
						const previousTimestamp = lastTokenTimestamp
							? lastTokenTimestamp.getTime()
							: promptedAt.getTime();
						metrics.model.timePerOutputToken.observe(metricsLabels, now - previousTimestamp);
					}
					lastTokenTimestamp = new Date();
				} else if (
					event.type === MessageUpdateType.Reasoning &&
					event.subtype === MessageReasoningUpdateType.Stream &&
					"token" in event
				) {
					messageToWriteTo.reasoning ??= "";
					messageToWriteTo.reasoning += event.token;
				} else if (event.type === MessageUpdateType.Title) {
					// browser persists the title; just sanitize the streamed value
					const sanitizedTitle = stripReasoningBlocks(event.title).trim();
					conv.title = sanitizedTitle || conv.title;
				} else if (event.type === MessageUpdateType.FinalAnswer) {
					messageToWriteTo.interrupted = event.interrupted;
					const hadTools = (messageToWriteTo.updates ?? []).some(
						(u) => u.type === MessageUpdateType.Tool
					);
					if (hadTools) {
						const existing = messageToWriteTo.content.slice(initialMessageContent.length);
						if (existing && existing.length > 0) {
							if (event.text && existing.endsWith(event.text)) {
								messageToWriteTo.content = initialMessageContent + existing;
							} else if (event.text && event.text.startsWith(existing)) {
								messageToWriteTo.content = initialMessageContent + event.text;
							} else {
								const needsGap = !/\n\n$/.test(existing) && !/^\n/.test(event.text ?? "");
								messageToWriteTo.content =
									initialMessageContent + existing + (needsGap ? "\n\n" : "") + (event.text ?? "");
							}
						} else {
							messageToWriteTo.content = initialMessageContent + (event.text ?? "");
						}
					} else {
						messageToWriteTo.content = initialMessageContent + event.text;
					}
					finalAnswerReceived = true;
					if (metricsEnabled && metrics) {
						metrics.model.latency.observe(metricsLabels, Date.now() - promptedAt.getTime());
					}
				} else if (event.type === MessageUpdateType.File) {
					messageToWriteTo.files = [
						...(messageToWriteTo.files ?? []),
						{ type: "hash", name: event.name, value: event.sha, mime: event.mime },
					];
				} else if (event.type === MessageUpdateType.RouterMetadata) {
					if (model?.isRouter) {
						messageToWriteTo.routerMetadata = {
							route: event.route || messageToWriteTo.routerMetadata?.route || "",
							model: event.model || messageToWriteTo.routerMetadata?.model || "",
							provider: event.provider || messageToWriteTo.routerMetadata?.provider,
						};
					} else if (event.provider) {
						messageToWriteTo.routerMetadata = {
							route: messageToWriteTo.routerMetadata?.route || "",
							model: messageToWriteTo.routerMetadata?.model || "",
							provider: event.provider,
						};
					}
				}

				if (
					!(
						event.type === MessageUpdateType.Status &&
						event.status === MessageUpdateStatus.KeepAlive
					)
				) {
					messageToWriteTo.updates?.push(event);
				}

				// Avoid remote keylogging via packet-length analysis: pad stream tokens.
				// https://cdn.arstechnica.net/wp-content/uploads/2024/03/LLM-Side-Channel.pdf
				if (event.type === MessageUpdateType.Stream) {
					event = { ...event, token: event.token.padEnd(16, "\0") };
				}

				messageToWriteTo.updatedAt = new Date();

				if (clientDetached) return;
				try {
					controller.enqueue(JSON.stringify(event) + "\n");
					if (event.type === MessageUpdateType.FinalAnswer) {
						controller.enqueue(" ".repeat(4096));
					}
				} catch {
					clientDetached = true;
					logger.info({ conversationId: id }, "Client detached during message streaming");
				}
			}

			let hasError = false;

			const emitInterruptedFinalAnswer = async () => {
				await update({
					type: MessageUpdateType.FinalAnswer,
					text: messageToWriteTo.content.slice(initialMessageContent.length),
					interrupted: true,
				});
			};

			try {
				locals.billingOrganization = clientOverrides?.billingOrganization;

				const ctx: TextGenerationContext = {
					model,
					endpoint: await model.getEndpoint(),
					conv,
					messages: messagesForPrompt,
					assistant: undefined,
					promptedAt,
					ip: getClientAddress(),
					username: locals.user?.username,
					forceMultimodal: !config.isHuggingChat && Boolean(clientOverrides?.forceMultimodal),
					forceTools: !config.isHuggingChat && Boolean(clientOverrides?.forceTools),
					provider: config.isHuggingChat && !model.isRouter ? clientOverrides?.provider : undefined,
					reasoningEffort: clientOverrides?.reasoningEffort,
					artifactsOverride: clientOverrides?.artifactsOverride,
					locals,
					abortController: ctrl,
				};

				for await (const event of textGeneration(ctx)) await update(event);
				if (ctrl.signal.aborted) {
					abortedByUser = true;
				}
				if (abortedByUser && !finalAnswerReceived) {
					await emitInterruptedFinalAnswer();
				}
			} catch (e) {
				const err = e as Error;
				const isAbortError =
					err?.name === "AbortError" ||
					err?.name === "APIUserAbortError" ||
					err?.constructor?.name === "APIUserAbortError" ||
					err?.message === "Request was aborted.";
				if (isAbortError || ctrl.signal.aborted) {
					abortedByUser = true;
					logger.info({ conversationId: id }, "Generation aborted by user");
					if (!finalAnswerReceived) {
						await emitInterruptedFinalAnswer();
					}
				} else {
					hasError = true;
					const errObj = err as unknown as Record<string, unknown>;
					const statusCode =
						(typeof errObj.statusCode === "number" ? errObj.statusCode : undefined) ||
						(typeof errObj.status === "number" ? errObj.status : undefined);
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: err.message,
						...(statusCode && { statusCode }),
					});
					logger.error(err, "Error in conversation stream");
				}
			} finally {
				if (!hasError && !abortedByUser && messageToWriteTo.content === initialMessageContent) {
					hasError = true;
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: "No output was generated. Something went wrong.",
					});
				}
			}

			if (!hasError && !finishedStatusSent) {
				await update({ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished });
			}

			if (!clientDetached) {
				controller.close();
			}
		},
		async cancel() {
			// The browser is the only owner of this generation; when it disconnects,
			// stop burning tokens upstream.
			clientDetached = true;
			streamAbortController?.abort();
		},
	});

	if (metricsEnabled && metrics) {
		metrics.model.messagesTotal.inc(metricsLabels);
		// No POST /conversation in DB-free mode: count a new conversation on the
		// first turn (no prior assistant reply in the prompt subtree).
		if (!messagesForPrompt.some((m) => m.from === "assistant")) {
			metrics.model.conversationsTotal.inc(metricsLabels);
		}
	}

	return new Response(stream, {
		headers: { "Content-Type": "application/jsonl" },
	});
}
