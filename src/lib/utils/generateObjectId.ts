/**
 * Generate a MongoDB ObjectId-shaped id (24 hex chars) on the client.
 *
 * Used in client-state ("DB-free") mode where conversation ids are minted in the
 * browser instead of by MongoDB. The ObjectId shape (4-byte timestamp + 8 random
 * bytes) is deliberate: server-mode routes still parse ids via `new ObjectId(id)`,
 * so a client-minted id stays valid if a conversation is ever promoted to a DB.
 */
export function generateObjectId(): string {
	const timestampHex = Math.floor(Date.now() / 1000)
		.toString(16)
		.padStart(8, "0");

	const random = new Uint8Array(8);
	crypto.getRandomValues(random);
	const randomHex = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");

	return timestampHex + randomHex;
}
