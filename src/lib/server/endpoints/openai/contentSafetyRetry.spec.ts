import { describe, it, expect, vi } from "vitest";
import { Stream } from "openai/streaming";
import {
	CONTENT_SAFETY_MODEL_PREFIX,
	createCompletionWithoutContentSafety,
	createStreamWithoutContentSafety,
	isContentSafetyModel,
} from "./contentSafetyRetry";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const SAFETY_MODEL = `${CONTENT_SAFETY_MODEL_PREFIX}-20260604:free`;
const GOOD_MODEL = "nvidia/nemotron-nano-12b-v2-vl:free";

type Chunk = { model: string; value: number };

/** Build a real OpenAI Stream that yields the given chunks. */
function makeStream(chunks: Chunk[], controller = new AbortController()): Stream<Chunk> {
	return new Stream<Chunk>(async function* () {
		for (const chunk of chunks) {
			yield chunk;
		}
	}, controller);
}

/** Build N chunks all reporting the same model. */
function chunksFor(model: string, count = 3): Chunk[] {
	return Array.from({ length: count }, (_, i) => ({ model, value: i }));
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of stream) {
		out.push(item);
	}
	return out;
}

/** Pop the next queued value, failing loudly if the queue was drained unexpectedly. */
function dequeue<T>(queue: T[]): T {
	const item = queue.shift();
	if (item === undefined) {
		throw new Error("test queue exhausted: helper requested more responses than expected");
	}
	return item;
}

describe("isContentSafetyModel", () => {
	it("matches the content-safety model prefix", () => {
		expect(isContentSafetyModel(SAFETY_MODEL)).toBe(true);
		expect(isContentSafetyModel(CONTENT_SAFETY_MODEL_PREFIX)).toBe(true);
	});

	it("does not match other models or empty values", () => {
		expect(isContentSafetyModel(GOOD_MODEL)).toBe(false);
		expect(isContentSafetyModel(undefined)).toBe(false);
		expect(isContentSafetyModel(null)).toBe(false);
		expect(isContentSafetyModel("")).toBe(false);
	});
});

describe("createStreamWithoutContentSafety", () => {
	it("passes through a non-content-safety stream without retrying", async () => {
		const createStream = vi.fn(async () => makeStream(chunksFor(GOOD_MODEL)));

		const result = await createStreamWithoutContentSafety(createStream);

		expect(createStream).toHaveBeenCalledTimes(1);
		expect(await collect(result)).toEqual(chunksFor(GOOD_MODEL));
	});

	it("returns a real Stream that replays the peeked first chunk", async () => {
		const result = await createStreamWithoutContentSafety(async () =>
			makeStream(chunksFor(GOOD_MODEL))
		);

		expect(result).toBeInstanceOf(Stream);
		// The first chunk (consumed to read .model) must not be dropped.
		expect(await collect(result)).toHaveLength(3);
	});

	it("retries and aborts the in-flight stream when it resolves to content-safety", async () => {
		const safetyController = new AbortController();
		const abortSpy = vi.spyOn(safetyController, "abort");
		const queue = [
			makeStream(chunksFor(SAFETY_MODEL), safetyController),
			makeStream(chunksFor(GOOD_MODEL)),
		];
		const createStream = vi.fn(async () => dequeue(queue));

		const result = await createStreamWithoutContentSafety(createStream);

		expect(createStream).toHaveBeenCalledTimes(2);
		expect(abortSpy).toHaveBeenCalledTimes(1);
		expect(await collect(result)).toEqual(chunksFor(GOOD_MODEL));
	});

	it("gives up after the retry budget and proceeds with the content-safety stream", async () => {
		const createStream = vi.fn(async () => makeStream(chunksFor(SAFETY_MODEL)));

		const result = await createStreamWithoutContentSafety(createStream);

		// 1 initial attempt + 3 retries = 4 calls.
		expect(createStream).toHaveBeenCalledTimes(4);
		expect(await collect(result)).toEqual(chunksFor(SAFETY_MODEL));
	});

	it("shares the chosen stream's controller so aborts propagate", async () => {
		const controller = new AbortController();
		const result = await createStreamWithoutContentSafety(async () =>
			makeStream(chunksFor(GOOD_MODEL), controller)
		);

		expect(result.controller).toBe(controller);
	});
});

describe("createCompletionWithoutContentSafety", () => {
	it("returns a non-content-safety completion without retrying", async () => {
		const createCompletion = vi.fn(async () => ({ model: GOOD_MODEL }));

		const result = await createCompletionWithoutContentSafety(createCompletion);

		expect(createCompletion).toHaveBeenCalledTimes(1);
		expect(result.model).toBe(GOOD_MODEL);
	});

	it("retries until it gets a usable model", async () => {
		const queue = [{ model: SAFETY_MODEL }, { model: SAFETY_MODEL }, { model: GOOD_MODEL }];
		const createCompletion = vi.fn(async () => dequeue(queue));

		const result = await createCompletionWithoutContentSafety(createCompletion);

		expect(createCompletion).toHaveBeenCalledTimes(3);
		expect(result.model).toBe(GOOD_MODEL);
	});

	it("gives up after the retry budget and returns the content-safety completion", async () => {
		const createCompletion = vi.fn(async () => ({ model: SAFETY_MODEL }));

		const result = await createCompletionWithoutContentSafety(createCompletion);

		expect(createCompletion).toHaveBeenCalledTimes(4);
		expect(result.model).toBe(SAFETY_MODEL);
	});
});
