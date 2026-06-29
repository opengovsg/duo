import { setSessionCookie, tokenSetToOauth, OIDConfig } from "$lib/server/auth";
import { z } from "zod";
import type { UserinfoResponse, TokenSet } from "openid-client";
import { type Cookies } from "@sveltejs/kit";
import { logger } from "$lib/server/logger";

/**
 * Seal the authenticated user's identity + OAuth token into the session cookie.
 * Stateless: there is no `users`/`sessions` collection — the cookie is the session.
 */
export async function updateUser(params: {
	userData: UserinfoResponse;
	token: TokenSet;
	locals: App.Locals;
	cookies: Cookies;
	userAgent?: string;
	ip?: string;
}) {
	const { userData, token, cookies } = params;

	// Microsoft Entra v1 tokens do not provide preferred_username, instead the username is provided in the upn
	// claim. See https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
	if (!userData.preferred_username && userData.upn) {
		userData.preferred_username = userData.upn as string;
	}

	const {
		preferred_username: username,
		name,
		email,
		picture: avatarUrl,
		sub: hfUserId,
	} = z
		.object({
			preferred_username: z.string().optional(),
			name: z.string(),
			picture: z.string().optional(),
			sub: z.string(),
			email: z.string().email().optional(),
		})
		.setKey(OIDConfig.NAME_CLAIM, z.string())
		.refine((data) => data.preferred_username || data.email, {
			message: "Either preferred_username or email must be provided by the provider.",
		})
		.transform((data) => ({
			...data,
			name: data[OIDConfig.NAME_CLAIM],
		}))
		.parse(userData) as {
		preferred_username?: string;
		email?: string;
		picture?: string;
		sub: string;
		name: string;
	} & Record<string, string>;

	logger.info({ login_username: username, login_name: name, login_email: email }, "user login");

	await setSessionCookie(cookies, {
		user: {
			hfUserId,
			username,
			name,
			email,
			avatarUrl: avatarUrl ?? "",
		},
		oauth: tokenSetToOauth(token),
	});
}
