import { Stream } from "openai/streaming";
import { logger } from "$lib/server/logger";

/**
 * Kilo's `openrouter/free` alias occasionally routes requests (especially
 * multimodal/image ones) to NVIDIA's content-safety classifier rather than a
 * general-purpose LLM. That model is a safety classifier: instead of answering
 * the prompt it returns a verdict like "User Safety: safe", which is useless as
 * a chat response. Routing appears non-deterministic, so simply re-issuing the
 * request almost always lands on a usable model.
 *
 * We detect these responses by inspecting the `model` field returned by the
 * upstream API and retry when it matches the classifier.
 */
export const CONTENT_SAFETY_MODEL_PREFIX = "nvidia/nemotron-3.5-content-safety";

/** Number of times to re-issue a request that resolved to the content-safety model. */
const MAX_CONTENT_SAFETY_RETRIES = 3;

export function isContentSafetyModel(model?: string | null): boolean {
	return typeof model === "string" && model.startsWith(CONTENT_SAFETY_MODEL_PREFIX);
}

/** Anything carrying a `model` field — both chat and legacy-completion chunks qualify. */
type WithModel = { model?: string | null };

/**
 * Wrap a streaming completion request (chat or legacy text completions) so that,
 * if the upstream resolves to the content-safety classifier, the stream is
 * discarded and the request is re-issued. Detection relies on the `model` field
 * present on the first chunk.
 *
 * `createStream` must start a fresh request on every call (so retries actually
 * re-route). The accepted stream is consumed up to its first chunk to read the
 * model; a new {@link Stream} is returned that replays that first chunk and then
 * delegates to the rest, while sharing the original `controller` so aborting the
 * returned stream still cancels the underlying request.
 */
export async function createStreamWithoutContentSafety<T extends WithModel>(
	createStream: () => Promise<Stream<T>>
): Promise<Stream<T>> {
	for (let attempt = 0; ; attempt += 1) {
		const stream = await createStream();
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		const model = first.done ? undefined : first.value.model;

		if (isContentSafetyModel(model)) {
			if (attempt < MAX_CONTENT_SAFETY_RETRIES) {
				logger.warn(
					{ model, attempt },
					"[content-safety] discarding content-safety classifier stream, retrying"
				);
				// Abort the in-flight stream so we don't leak the connection.
				try {
					stream.controller.abort();
				} catch {
					// best-effort; ignore if already settled
				}
				continue;
			}
			logger.warn(
				{ model, attempt },
				"[content-safety] still resolved to content-safety model after retries, proceeding"
			);
		}

		// Replay the peeked chunk in front of the untouched remainder, wrapped back
		// into a real Stream so callers keep the full Stream API (tee, controller…).
		return new Stream<T>(async function* () {
			if (!first.done) {
				yield first.value;
			}
			let next = await iterator.next();
			while (!next.done) {
				yield next.value;
				next = await iterator.next();
			}
		}, stream.controller);
	}
}

/**
 * Non-streaming counterpart of {@link createStreamWithoutContentSafety}.
 * Re-issues the request while it resolves to the content-safety classifier.
 */
export async function createCompletionWithoutContentSafety<T extends WithModel>(
	createCompletion: () => Promise<T>
): Promise<T> {
	let completion = await createCompletion();
	for (
		let attempt = 0;
		isContentSafetyModel(completion.model) && attempt < MAX_CONTENT_SAFETY_RETRIES;
		attempt += 1
	) {
		logger.warn(
			{ model: completion.model, attempt },
			"[content-safety] discarding content-safety classifier response, retrying"
		);
		completion = await createCompletion();
	}
	if (isContentSafetyModel(completion.model)) {
		logger.warn(
			{ model: completion.model },
			"[content-safety] still resolved to content-safety model after retries, proceeding"
		);
	}
	return completion;
}
