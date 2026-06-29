import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { generateObjectId } from "./generateObjectId";

describe("generateObjectId", () => {
	it("produces a 24-char hex string", () => {
		const id = generateObjectId();
		expect(id).toMatch(/^[0-9a-f]{24}$/);
	});

	it("is parseable as a MongoDB ObjectId (round-trips)", () => {
		const id = generateObjectId();
		expect(new ObjectId(id).toString()).toBe(id);
	});

	it("is effectively unique across many calls", () => {
		const ids = new Set(Array.from({ length: 1000 }, () => generateObjectId()));
		expect(ids.size).toBe(1000);
	});

	it("encodes the current time in the leading 4 bytes", () => {
		const before = Math.floor(Date.now() / 1000);
		const ts = parseInt(generateObjectId().slice(0, 8), 16);
		const after = Math.floor(Date.now() / 1000);
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after + 1);
	});
});
