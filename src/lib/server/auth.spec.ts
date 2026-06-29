import { describe, expect, it } from "vitest";
import type { Cookies } from "@sveltejs/kit";
import type { TokenSet } from "openid-client";
import {
	authenticateRequest,
	setSessionCookie,
	clearSessionCookie,
	tokenSetToOauth,
	type SessionData,
} from "./auth";

/** Minimal in-memory Cookies stand-in (only get/set/delete are exercised). */
function makeCookies(): Cookies & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: (name: string) => store.get(name),
		getAll: () => [...store.entries()].map(([name, value]) => ({ name, value })),
		set: (name: string, value: string) => {
			store.set(name, value);
		},
		delete: (name: string) => {
			store.delete(name);
		},
		serialize: () => "",
	} as unknown as Cookies & { store: Map<string, string> };
}

const url = new URL("http://localhost/");

const baseUser: SessionData["user"] = {
	hfUserId: "user-123",
	username: "alice",
	name: "Alice Example",
	email: "alice@example.com",
	avatarUrl: "https://example.com/a.png",
};

describe("iron-session auth", () => {
	it("seals and unseals a session round-trip", async () => {
		const cookies = makeCookies();
		await setSessionCookie(cookies, {
			user: baseUser,
			oauth: { accessToken: "tok-abc", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 },
		});

		// the cookie value is opaque (sealed), not the plaintext token
		const sealed = cookies.get("hf-chat");
		expect(sealed).toBeTruthy();
		expect(sealed).not.toContain("tok-abc");

		const { user, token } = await authenticateRequest(new Headers(), cookies, url);
		expect(user?.hfUserId).toBe("user-123");
		expect(user?.username).toBe("alice");
		expect(user?.email).toBe("alice@example.com");
		// deterministic ObjectId derived from the subject
		expect(user?._id?.toString()).toMatch(/^[0-9a-f]{24}$/);
		expect(token).toBe("tok-abc");
	});

	it("returns no user when there is no cookie", async () => {
		const { user, token } = await authenticateRequest(new Headers(), makeCookies(), url);
		expect(user).toBeUndefined();
		expect(token).toBeUndefined();
	});

	it("returns no user for a tampered / unsealable cookie", async () => {
		const cookies = makeCookies();
		cookies.set("hf-chat", "not-a-valid-seal", {} as never);
		const { user } = await authenticateRequest(new Headers(), cookies, url);
		expect(user).toBeUndefined();
	});

	it("clears the cookie when the token is expired and unrefreshable", async () => {
		const cookies = makeCookies();
		await setSessionCookie(cookies, {
			user: baseUser,
			// expired, and no refresh token -> cannot refresh (no network call)
			oauth: { accessToken: "tok-old", expiresAt: Date.now() - 1_000 },
		});
		expect(cookies.get("hf-chat")).toBeTruthy();

		const { user } = await authenticateRequest(new Headers(), cookies, url);
		expect(user).toBeUndefined();
		// the stale cookie is removed
		expect(cookies.get("hf-chat")).toBeUndefined();
	});

	it("supports an identity-only session (no oauth token)", async () => {
		const cookies = makeCookies();
		await setSessionCookie(cookies, { user: baseUser });
		const { user, token } = await authenticateRequest(new Headers(), cookies, url);
		expect(user?.hfUserId).toBe("user-123");
		expect(token).toBeUndefined();
	});

	it("clearSessionCookie removes the session", async () => {
		const cookies = makeCookies();
		await setSessionCookie(cookies, { user: baseUser });
		clearSessionCookie(cookies);
		expect(cookies.get("hf-chat")).toBeUndefined();
	});

	it("tokenSetToOauth maps fields and applies the 1-minute expiry skew", () => {
		const expiresAtSec = Math.floor(Date.now() / 1000) + 3600;
		const oauth = tokenSetToOauth({
			access_token: "abc",
			refresh_token: "ref",
			expires_at: expiresAtSec,
		} as TokenSet);
		expect(oauth?.accessToken).toBe("abc");
		expect(oauth?.refreshToken).toBe("ref");
		expect(oauth?.expiresAt).toBe(expiresAtSec * 1000 - 60_000);
	});

	it("tokenSetToOauth returns undefined without an access token", () => {
		expect(tokenSetToOauth({} as TokenSet)).toBeUndefined();
	});
});
