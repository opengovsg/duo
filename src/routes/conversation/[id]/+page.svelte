<script lang="ts">
	import ChatWindow from "$lib/components/chat/ChatWindow.svelte";
	import { consumePendingFiles } from "$lib/utils/pendingFiles";
	import { isAborted } from "$lib/stores/isAborted";
	import { onMount, untrack } from "svelte";
	import { page } from "$app/state";
	import { beforeNavigate, replaceState } from "$app/navigation";
	import { base } from "$app/paths";
	import { ERROR_MESSAGES, error } from "$lib/stores/errors";
	import { findCurrentModel } from "$lib/utils/models";
	import type { Message } from "$lib/types/Message";
	import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";
	import { useConversationsStore } from "$lib/stores/conversations.svelte";
	import file2base64 from "$lib/utils/file2base64";
	import { addChildren } from "$lib/utils/tree/addChildren";
	import { addSibling } from "$lib/utils/tree/addSibling";
	import { buildSubtree } from "$lib/utils/tree/buildSubtree";
	import { fetchMessageUpdates, resolveStreamingMode } from "$lib/utils/messageUpdates";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { v4 } from "uuid";
	import { useSettingsStore } from "$lib/stores/settings.js";
	import { enabledServers, mcpServersLoaded } from "$lib/stores/mcpServers";
	import { get } from "svelte/store";
	import { browser } from "$app/environment";
	import {
		addBackgroundGeneration,
		removeBackgroundGeneration,
	} from "$lib/stores/backgroundGenerations";
	import type { TreeNode, TreeId } from "$lib/utils/tree/tree";
	import "katex/dist/katex.min.css";
	import { updateDebouncer } from "$lib/utils/updates.js";
	import SubscribeModal from "$lib/components/SubscribeModal.svelte";
	import { loading } from "$lib/stores/loading.js";
	import { streamStart } from "$lib/utils/haptics";
	import { requireAuthUser } from "$lib/utils/auth.js";
	import { isConversationGenerationActive, isGenerationStale } from "$lib/utils/generationState";
	import SharePreviewTags from "$lib/components/SharePreviewTags.svelte";

	// IndexedDB persistence for offline fallback
	import { conversationRepository } from "$lib/repositories/ConversationRepository";
	import superjson from "superjson";

	let { data } = $props();

	// Obtain the conversations store during component init (context must be read
	// synchronously, not inside async callbacks or event handlers).
	const convsStore = useConversationsStore();

	// Client-state ("DB-free") mode: the browser owns the conversation tree and
	// persists it in IndexedDB; the generation endpoint runs statelessly.
	const publicConfig = usePublicConfig();
	const isClientState = publicConfig.isStateClient;

	let convId = $derived(page.params.id ?? "");
	let pending = $state(false);
	let initialRun = true;
	let showSubscribeModal = $state(false);
	// Conversation-scoped stop tombstone. A boolean reset on page.params.id
	// changes resurrects the generating UI: invalidation reassigns page.params,
	// which clears the flag while the stopped conversation's snapshot is still
	// non-terminal, flipping $loading back on. Keying the tombstone by
	// conversation id makes it survive invalidations; it expires when a new
	// generation starts in this conversation.
	let stopRequestedFor: string | null = $state(null);
	let stopRequestPromise: Promise<void> | undefined;
	// Id of the generation run this tab started, sent with the generation
	// request and echoed in the stop request so the server can clamp the
	// persisted text to the stop point of the run it belongs to.
	let activeGenerationId: string | undefined;
	// True while writeMessage runs; lets the generation-state effect skip the
	// snapshot-staleness check for the generation streaming in this very tab.
	let writeMessageInFlight = false;
	let messageUpdatesAbortController = new AbortController();

	let files: File[] = $state([]);

	function createMessagesPath<T>(messages: TreeNode<T>[], msgId?: TreeId): TreeNode<T>[] {
		if (initialRun) {
			if (!msgId && page.url.searchParams.get("leafId")) {
				msgId = page.url.searchParams.get("leafId") as string;
				page.url.searchParams.delete("leafId");
			}
			if (!msgId && browser && localStorage.getItem("leafId")) {
				msgId = localStorage.getItem("leafId") as string;
			}
			initialRun = false;
		}

		const msg = messages.find((msg) => msg.id === msgId) ?? messages.at(-1);
		if (!msg) return [];
		// ancestor path
		const { ancestors } = msg;
		const path = [];
		if (ancestors?.length) {
			for (const ancestorId of ancestors) {
				const ancestor = messages.find((msg) => msg.id === ancestorId);
				if (ancestor) {
					path.push(ancestor);
				}
			}
		}

		// push the node itself in the middle
		path.push(msg);

		// children path
		let childrenIds = msg.children;
		while (childrenIds?.length) {
			let lastChildId = childrenIds.at(-1);
			const lastChild = messages.find((msg) => msg.id === lastChildId);
			if (lastChild) {
				path.push(lastChild);
			}
			childrenIds = lastChild?.children;
		}

		return path;
	}

	function createMessagesAlternatives<T>(messages: TreeNode<T>[]): TreeId[][] {
		const alternatives = [];
		for (const message of messages) {
			if (message.children?.length) {
				alternatives.push(message.children);
			}
		}
		return alternatives;
	}

	// Resolve the per-model settings overrides that server mode reads from the
	// `settings` collection. In client-state mode they travel with the request.
	function buildClientOverrides(modelId: string) {
		const s = get(settings);
		const currentModel = findCurrentModel(data.models, data.oldModels, modelId);
		const reasoningEnabled = s.reasoningOverrides?.[modelId] ?? currentModel?.supportsReasoning;
		return {
			forceMultimodal: s.multimodalOverrides?.[modelId] || undefined,
			forceTools: s.toolsOverrides?.[modelId] || undefined,
			provider: s.providerOverrides?.[modelId] || undefined,
			reasoningEffort: reasoningEnabled ? s.reasoningEffortOverrides?.[modelId] : undefined,
			artifactsOverride: s.artifactsOverrides?.[modelId],
			billingOrganization: s.billingOrganization,
		};
	}

	// Commit the browser-owned conversation to IndexedDB and reflect it in the
	// sidebar. Replaces the server invalidation/refresh used in server mode.
	async function persistConversationLocally() {
		if (!browser || !isClientState || !convId) return;
		const title = convsStore.list.find((c) => c.id === convId)?.title ?? data.title;
		await conversationRepository.setConversationDetail(convId, {
			title,
			model: data.model,
			updatedAt: new Date().toISOString(),
			messages: superjson.stringify(messages),
			preprompt: data.preprompt,
			rootMessageId,
			shared: data.shared,
			modelId: data.modelId,
		});
		if (convsStore.list.some((c) => c.id === convId)) {
			convsStore.update(convId, { updatedAt: new Date(), title });
		} else {
			convsStore.prepend({ id: convId, title, model: data.model, updatedAt: new Date() });
		}
	}

	// this function is used to send new message to the backends
	async function writeMessage({
		prompt,
		messageId = messagesPath.at(-1)?.id ?? undefined,
		isRetry = false,
	}: {
		prompt?: string;
		messageId?: string;
		isRetry?: boolean;
	}): Promise<void> {
		try {
			stopRequestedFor = null;
			$isAborted = false;
			$loading = true;
			pending = true;
			writeMessageInFlight = true;
			// Create the controller before any await: a Stop click during file
			// encoding or MCP hydration must abort THIS request, not whichever
			// stale controller a previous generation left behind.
			messageUpdatesAbortController = new AbortController();
			activeGenerationId = v4();
			const base64Files = await Promise.all(
				(files ?? []).map((file) =>
					file2base64(file).then((value) => ({
						type: "base64" as const,
						value,
						mime: file.type,
						name: file.name,
					}))
				)
			);

			let messageToWriteToId: Message["id"] | undefined = undefined;
			// used for building the prompt, subtree of the conversation that goes from the latest message to the root
			// In client-state mode we build the prompt subtree here (the server is
			// stateless): track which leaf to build it from.
			let promptLeafId: Message["id"] | undefined = undefined;
			let popPromptLeaf = false;

			if (isRetry && messageId) {
				// two cases, if we're retrying a user message with a newPrompt set,
				// it means we're editing a user message
				// if we're retrying on an assistant message, newPrompt cannot be set
				// it means we're retrying the last assistant message for a new answer

				const messageToRetry = messages.find((message) => message.id === messageId);

				if (!messageToRetry) {
					$error = "Message not found";
				}

				if (messageToRetry?.from === "user" && prompt) {
					// add a sibling to this message from the user, with the alternative prompt
					// add a children to that sibling, where we can write to
					const newUserMessageId = addSibling(
						{
							messages,
							rootMessageId,
						},
						{
							from: "user",
							content: prompt,
							files: messageToRetry.files,
						},
						messageId
					);
					messageToWriteToId = addChildren(
						{
							messages,
							rootMessageId,
						},
						{ from: "assistant", content: "" },
						newUserMessageId
					);
					promptLeafId = newUserMessageId;
				} else if (messageToRetry?.from === "assistant") {
					// we're retrying an assistant message, to generate a new answer
					// just add a sibling to the assistant answer where we can write to
					messageToWriteToId = addSibling(
						{
							messages,
							rootMessageId,
						},
						{ from: "assistant", content: "" },
						messageId
					);
					// prompt is the path up to (but not including) the assistant being retried
					promptLeafId = messageId;
					popPromptLeaf = true;
				}
			} else {
				// just a normal linear conversation, so we add the user message
				// and the blank assistant message back to back
				const newUserMessageId = addChildren(
					{
						messages,
						rootMessageId,
					},
					{
						from: "user",
						content: prompt ?? "",
						files: base64Files,
					},
					messageId
				);

				if (!rootMessageId) {
					rootMessageId = newUserMessageId;
				}

				messageToWriteToId = addChildren(
					{
						messages,
						rootMessageId,
					},
					{
						from: "assistant",
						content: "",
					},
					newUserMessageId
				);
				promptLeafId = newUserMessageId;
			}

			const userMessage = messages.find((message) => message.id === messageId);
			const messageToWriteTo = messages.find((message) => message.id === messageToWriteToId);
			if (!messageToWriteTo) {
				throw new Error("Message to write to not found");
			}

			const streamingMode = resolveStreamingMode($settings);

			// Wait for the MCP store to hydrate before sending so the server receives
			// the user's exact selection. Sending [] before the base server list is
			// fetched filters env servers to nothing; omitting the field would skip
			// any explicit opt-outs the user saved in localStorage.
			if (!get(mcpServersLoaded)) {
				await new Promise<void>((resolve) => {
					let unsub: (() => void) | undefined;
					unsub = mcpServersLoaded.subscribe((loaded) => {
						if (loaded) {
							// unsub may still be undefined if subscribe fires synchronously
							unsub?.();
							resolve();
						}
					});
				});
			}

			// In client-state mode build the root→leaf prompt subtree the stateless
			// server will generate from (with inline base64 attachments).
			let clientState: Parameters<typeof fetchMessageUpdates>[1]["clientState"];
			if (isClientState && promptLeafId) {
				const subtree = buildSubtree({ messages, rootMessageId }, promptLeafId);
				if (popPromptLeaf) subtree.pop();
				clientState = {
					model: data.model,
					messages: subtree as Message[],
					overrides: buildClientOverrides(data.model),
				};
			}

			const messageUpdatesIterator = await fetchMessageUpdates(
				convId,
				{
					base,
					inputs: prompt,
					messageId,
					isRetry,
					generationId: activeGenerationId,
					files: isRetry ? userMessage?.files : base64Files,
					selectedMcpServerNames: $enabledServers.map((s) => s.name),
					selectedMcpServers: $enabledServers.map((s) => ({
						name: s.name,
						url: s.url,
						headers: s.headers,
					})),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					streamingMode,
					clientState,
				},
				messageUpdatesAbortController.signal
			).catch((err) => {
				// A user abort rejects the fetch; that is not an error worth a toast
				if (!$isAborted && !(err instanceof DOMException && err.name === "AbortError")) {
					error.set(err.message);
				}
			});
			if (messageUpdatesIterator === undefined) return;

			files = [];
			let buffer = "";
			// Initialize lastUpdateTime outside the loop to persist between updates
			let lastUpdateTime = new Date();
			let frameFlushScheduled = false;

			const flushBuffer = (currentTime: Date) => {
				if (buffer.length === 0) return;
				messageToWriteTo.content += buffer;
				buffer = "";
				lastUpdateTime = currentTime;
			};

			const scheduleFrameFlush = () => {
				if (frameFlushScheduled) return;
				frameFlushScheduled = true;
				const flush = () => {
					frameFlushScheduled = false;
					flushBuffer(new Date());
				};
				if (typeof requestAnimationFrame === "function") {
					requestAnimationFrame(flush);
				} else {
					setTimeout(flush, 0);
				}
			};

			for await (const update of messageUpdatesIterator) {
				if ($isAborted) {
					messageUpdatesAbortController.abort();
					return;
				}

				// Remove null characters added due to remote keylogging prevention
				// See server code for more details
				if (update.type === MessageUpdateType.Stream) {
					update.token = update.token.replaceAll("\0", "");
				}

				const isKeepAlive =
					update.type === MessageUpdateType.Status &&
					update.status === MessageUpdateStatus.KeepAlive;

				if (!isKeepAlive) {
					if (update.type === MessageUpdateType.Stream) {
						const existingUpdates = messageToWriteTo.updates ?? [];
						const lastUpdate = existingUpdates.at(-1);
						if (lastUpdate?.type === MessageUpdateType.Stream) {
							// Create fresh objects/arrays so the UI reacts to merged tokens
							const merged = {
								...lastUpdate,
								token: (lastUpdate.token ?? "") + (update.token ?? ""),
							};
							messageToWriteTo.updates = [...existingUpdates.slice(0, -1), merged];
						} else {
							messageToWriteTo.updates = [...existingUpdates, update];
						}
					} else {
						messageToWriteTo.updates = [...(messageToWriteTo.updates ?? []), update];
					}
				}
				const currentTime = new Date();

				// If we receive a non-stream update (e.g. tool/status/final answer),
				// flush any buffered stream tokens so the UI doesn't appear to cut
				// mid-sentence while tools are running or the final answer arrives.
				if (update.type !== MessageUpdateType.Stream && buffer.length > 0) {
					flushBuffer(currentTime);
				}

				if (update.type === MessageUpdateType.Stream) {
					buffer += update.token;
					if (streamingMode === "smooth") {
						// Coalesce UI updates to animation frames for smooth mode.
						scheduleFrameFlush();
					} else if (
						currentTime.getTime() - lastUpdateTime.getTime() >
						updateDebouncer.maxUpdateTime
					) {
						flushBuffer(currentTime);
					}
					if (pending) {
						streamStart();
					}
					pending = false;
				} else if (update.type === MessageUpdateType.FinalAnswer) {
					// Mirror server-side merge behavior so the UI reflects the
					// final text once tools complete, while preserving any
					// pre‑tool streamed content when appropriate.
					const finalText = update.text ?? "";
					const isInterrupted = update.interrupted === true;
					const hadTools =
						messageToWriteTo.updates?.some((u) => u.type === MessageUpdateType.Tool) ?? false;

					if (isInterrupted) {
						if (!messageToWriteTo.content) {
							// We never streamed anything; fall back to finalText.
							messageToWriteTo.content = finalText;
						} else if (finalText && messageToWriteTo.content.startsWith(finalText)) {
							// The server may have clamped the persisted text back to a
							// reported stop point (see stop-generating). Adopt it when it
							// is a prefix of what we streamed so this view matches what
							// every other view will load; otherwise keep our streamed
							// content (continue flows receive only the post-prefix text).
							messageToWriteTo.content = finalText;
						}
					} else if (hadTools) {
						const existing = messageToWriteTo.content;
						const trimmedExistingSuffix = existing.replace(/\s+$/, "");
						const trimmedFinalPrefix = finalText.replace(/^\s+/, "");
						const alreadyStreamed =
							finalText &&
							(existing.endsWith(finalText) ||
								(trimmedFinalPrefix.length > 0 &&
									trimmedExistingSuffix.endsWith(trimmedFinalPrefix)));

						if (existing && existing.length > 0) {
							if (alreadyStreamed) {
								// A. Already streamed the same final text; keep as-is.
								messageToWriteTo.content = existing;
							} else if (
								finalText &&
								(finalText.startsWith(existing) ||
									(trimmedExistingSuffix.length > 0 &&
										trimmedFinalPrefix.startsWith(trimmedExistingSuffix)))
							) {
								// B. Final text already includes streamed prefix; use it verbatim.
								messageToWriteTo.content = finalText;
							} else {
								// C. Merge with a paragraph break for readability.
								const needsGap = !/\n\n$/.test(existing) && !/^\n/.test(finalText ?? "");
								messageToWriteTo.content = existing + (needsGap ? "\n\n" : "") + finalText;
							}
						} else {
							messageToWriteTo.content = finalText;
						}
					} else {
						// No tools: final answer replaces streamed content so
						// the provider's final text is authoritative.
						messageToWriteTo.content = finalText;
					}
				} else if (
					update.type === MessageUpdateType.Status &&
					update.status === MessageUpdateStatus.Error
				) {
					// Check if this is a 402 payment required error
					if (update.statusCode === 402) {
						showSubscribeModal = true;
					} else if (
						update.statusCode === 401 &&
						typeof update.message === "string" &&
						/oauth authorization|has been revoked|requested scopes/i.test(update.message)
					) {
						// The stored OAuth token was revoked or no longer matches scopes.
						// Restart the OAuth flow and return to this conversation afterwards.
						const next = encodeURIComponent(`${base}/conversation/${convId}`);
						window.location.assign(`${base}/login?next=${next}`);
					} else {
						$error = update.message ?? "An error has occurred";
					}
				} else if (update.type === MessageUpdateType.Title) {
					// Update the sidebar title directly via the store — no side-channel needed.
					convsStore.update(convId, { title: update.title });
				} else if (update.type === MessageUpdateType.File) {
					messageToWriteTo.files = [
						...(messageToWriteTo.files ?? []),
						{ type: "hash", value: update.sha, mime: update.mime, name: update.name },
					];
				} else if (update.type === MessageUpdateType.RouterMetadata) {
					// Update router metadata immediately when received
					messageToWriteTo.routerMetadata = {
						route: update.route,
						model: update.model,
					};
				}
			}

			if (buffer.length > 0) {
				flushBuffer(new Date());
			}
		} catch (err) {
			if ($isAborted || (err instanceof DOMException && err.name === "AbortError")) {
				// User-initiated abort, not an error
			} else if (err instanceof Error && err.message.includes("overloaded")) {
				$error = "Too much traffic, please try again.";
			} else if (err instanceof Error && err.message.includes("429")) {
				$error = ERROR_MESSAGES.rateLimited;
			} else if (err instanceof Error) {
				$error = err.message;
			} else {
				$error = ERROR_MESSAGES.default;
			}
			console.error(err);
		} finally {
			writeMessageInFlight = false;
			activeGenerationId = undefined;
			$loading = false;
			pending = false;

			// Browser owns the state: commit to IndexedDB instead of invalidating
			// + refetching from the server. The local `messages` already hold the
			// terminal state the loop produced.
			await persistConversationLocally();
		}
	}

	async function stopGeneration() {
		// Snapshot the stop point first: the generation run this tab started
		// (if any) and how many characters of the reply are on screen right
		// now. The server clamps the persisted text back to this so the
		// interrupted message cannot "grow back" past what the user saw while
		// the abort marker was in flight.
		const lastAssistant = messages.findLast((m) => m.from === "assistant");
		const stopPoint =
			activeGenerationId !== undefined && lastAssistant
				? { generationId: activeGenerationId, seenContentLength: lastAssistant.content.length }
				: undefined;

		stopRequestedFor = convId;
		$isAborted = true;
		$loading = false;
		messageUpdatesAbortController.abort();

		// Mark the last assistant message as interrupted locally so
		// isConversationGenerationActive() immediately returns false,
		// removing the background poller and preventing $loading re-enable.
		if (lastAssistant) {
			lastAssistant.interrupted = true;
		}

		// Client-state mode: aborting the fetch (above) stops the stateless
		// generation; there is no server-side stop marker. writeMessage's finally
		// persists the interrupted state locally.
		if (isClientState) {
			return;
		}

		const sendStopRequest = async () => {
			const response = await fetch(`${base}/conversation/${page.params.id}/stop-generating`, {
				method: "POST",
				...(stopPoint && {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(stopPoint),
				}),
			});
			if (!response.ok) {
				throw new Error(`Stop request failed: ${response.status}`);
			}
		};

		// Store the promise so writeMessage's finally block can await it
		// before refreshing data. Losing this request entirely means the server
		// never learns about the stop (the abort marker is what cross-pod
		// generation watchers act on), so retry with backoff instead of giving
		// up after a single transient failure.
		stopRequestPromise = (async () => {
			const delays = [0, 300, 1000, 3000];
			for (const [attempt, delay] of delays.entries()) {
				if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
				try {
					await sendStopRequest();
					return;
				} catch (err) {
					if (attempt === delays.length - 1) {
						console.error("Failed to stop generation", err);
						$error = "Failed to stop generation. Please try again.";
					}
				}
			}
		})();

		await stopRequestPromise;
	}

	function handleKeydown(event: KeyboardEvent) {
		// Stop generation on ESC key when loading
		if (event.key === "Escape" && $loading) {
			event.preventDefault();
			stopGeneration();
		}
	}

	onMount(async () => {
		// Read the first message from SvelteKit shallow-routing history state.
		// Text is serialized directly; File objects travel via the pendingFiles
		// client-side Map, retrieved once by nonce and then discarded.
		// On a hard refresh page.state is empty, so both values are undefined
		// and we skip straight to the background-generation check below.
		const pendingText = page.state.pendingMessage as string | undefined;
		if (pendingText) {
			const nonce = page.state.pendingFilesNonce as string | undefined;
			files = nonce ? consumePendingFiles(nonce) : [];
			// Clear the history entry before submitting: returning to it via
			// Back/Forward re-runs onMount, and a lingering pendingMessage
			// would resubmit the prompt (without files, whose nonce is spent).
			replaceState("", {});
			await writeMessage({ prompt: pendingText });
		}

		// Don't resume tracking for stale snapshots: a generation that has gone
		// this long without a DB write died with its pod and will never finish.
		// Client-state mode has no server-side background generation to resume.
		const streaming =
			!isClientState &&
			isConversationGenerationActive(messages) &&
			!isGenerationStale(data.updatedAt);
		if (streaming) {
			addBackgroundGeneration({ id: convId, startedAt: Date.now() });
			$loading = true;
		}
	});

	async function onMessage(content: string) {
		await writeMessage({ prompt: content });
	}

	async function onRetry(payload: { id: Message["id"]; content?: string }) {
		if (requireAuthUser()) return;

		const lastMsgId = payload.id;
		messagesPath = createMessagesPath(messages, lastMsgId);

		await writeMessage({
			prompt: payload.content,
			messageId: payload.id,
			isRetry: true,
		});
	}

	async function onShowAlternateMsg(payload: { id: Message["id"] }) {
		const msgId = payload.id;
		messagesPath = createMessagesPath(messages, msgId);
	}

	const settings = useSettingsStore();
	let messages = $state(untrack(() => data.messages));
	// Local copy of rootMessageId avoids mutating the load-data prop directly.
	// It is set when the first message of a new conversation is created, and
	// re-synced from server data whenever the conversation changes.
	let rootMessageId = $state(untrack(() => data.rootMessageId));

	// Resync local message state from server data ONLY when the conversation
	// changes (sidebar navigation) or the load data itself was refreshed
	// (post-stream invalidation). Two hard constraints, both learned from
	// prod incidents:
	//
	// 1. `pending` must NOT be a reactive dependency of this effect. It flips
	//    false when the first streaming token arrives; reading it tracked made
	//    that flip re-run the effect and overwrite the locally appended
	//    user/assistant messages with the stale page-load snapshot, blanking
	//    the conversation until the stream finished (prod incident 2026-06-11).
	//    It is therefore only ever read inside untrack().
	// 2. A sync may only happen when `data.messages` identity actually changed
	//    (or the conversation changed): re-running this effect for any other
	//    reason must be a no-op.
	//
	// A mid-stream load refresh (pending still true) is intentionally skipped;
	// the finally block in writeMessage invalidates again after the stream
	// ends, so the post-completion sync still lands.
	let _lastSyncedConvId = untrack(() => convId); // plain variable — no reactive overhead needed
	let _lastSyncedMessages = untrack(() => data.messages); // plain variable — identity tracking only
	$effect(() => {
		const currentConvId = convId; // reactive dep
		const newMessages = data.messages; // reactive dep

		const convChanged = currentConvId !== _lastSyncedConvId;
		const dataChanged = newMessages !== _lastSyncedMessages;

		if (convChanged || (dataChanged && untrack(() => !pending))) {
			messages = newMessages;
			rootMessageId = data.rootMessageId;
			_lastSyncedConvId = currentConvId;
			_lastSyncedMessages = newMessages;

			// Persist the server-confirmed conversation to IndexedDB.
			// This fires whenever the load function returns fresh data (page
			// navigation or post-stream invalidation). Optimistic/transient
			// messages that haven't been acknowledged by the server are never
			// persisted — they remain only in the local `messages` state.
			if (browser && currentConvId) {
				void conversationRepository.setConversationDetail(currentConvId, {
					title: data.title,
					model: data.model,
					updatedAt: data.updatedAt.toISOString(),
					messages: superjson.stringify(newMessages),
					preprompt: data.preprompt,
					rootMessageId: data.rootMessageId,
					shared: data.shared,
					modelId: data.modelId,
				});
			}
		}
	});

	$effect(() => {
		const streaming =
			isConversationGenerationActive(messages) &&
			// A snapshot that has gone this long without a database write belongs
			// to a pod that died before persisting a terminal state; never
			// resurrect the streaming UI for it. Generations streaming in this
			// tab are exempt — their snapshot timestamp is from page-load time.
			(untrack(() => writeMessageInFlight) || !isGenerationStale(data.updatedAt));
		if (stopRequestedFor === convId) {
			$loading = false;
		} else if (streaming) {
			$loading = true;
		} else if (!pending) {
			$loading = false;
		}

		if (!streaming && browser) {
			removeBackgroundGeneration(convId);
		}
	});

	// create a linear list of `messagesPath` from `messages` that is a tree of threaded messages
	let messagesPath = $derived(createMessagesPath(messages));
	let messagesAlternatives = $derived(createMessagesAlternatives(messages));

	$effect(() => {
		if (browser && messagesPath.at(-1)?.id) {
			localStorage.setItem("leafId", messagesPath.at(-1)?.id as string);
		}
	});

	beforeNavigate((navigation) => {
		if (!page.params.id) return;

		const navigatingAway =
			navigation.to?.route.id !== page.route.id || navigation.to?.params?.id !== page.params.id;

		if ($loading && navigatingAway) {
			addBackgroundGeneration({ id: page.params.id, startedAt: Date.now() });
		}

		$isAborted = true;
		$loading = false;
		messageUpdatesAbortController.abort();
	});

	let title = $derived.by(() => {
		const rawTitle =
			convsStore.list.find((conv) => conv.id === page.params.id)?.title ?? data.title;
		return rawTitle ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1) : rawTitle;
	});

	// Social preview tags for shared conversation snapshots (7-char share ids),
	// for crawlers that scrape /conversation/{shareId} instead of /r/{shareId}
	let sharePreviewId = $derived(
		page.params.id && page.params.id.length === 7 ? page.params.id : undefined
	);
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{title}</title>
</svelte:head>

{#if sharePreviewId}
	<SharePreviewTags shareId={sharePreviewId} {title} {messages} {rootMessageId} />
{/if}

<ChatWindow
	loading={$loading}
	{pending}
	messages={messagesPath as Message[]}
	{messagesAlternatives}
	shared={data.shared}
	preprompt={data.preprompt}
	bind:files
	onmessage={onMessage}
	onretry={onRetry}
	onshowAlternateMsg={onShowAlternateMsg}
	onstop={stopGeneration}
	models={data.models}
	currentModel={findCurrentModel(data.models, data.oldModels, data.model)}
/>

{#if showSubscribeModal}
	<SubscribeModal close={() => (showSubscribeModal = false)} />
{/if}
