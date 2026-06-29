import {
	Issuer,
	type BaseClient,
	type UserinfoResponse,
	type TokenSet,
	custom,
	generators,
} from "openid-client";
import type { RequestEvent } from "@sveltejs/kit";
import { addHours, addWeeks, differenceInMinutes } from "date-fns";
import { config } from "$lib/server/config";
import { sha256 } from "$lib/utils/sha256";
import { z } from "zod";
import { dev } from "$app/environment";
import { redirect, type Cookies } from "@sveltejs/kit";
import { sealData, unsealData } from "iron-session";
import JSON5 from "json5";
import { logger } from "$lib/server/logger";
import { ObjectId } from "mongodb";
import type { User } from "$lib/types/User";
import { base } from "$app/paths";

export interface OIDCSettings {
	redirectURI: string;
}

export interface OIDCUserInfo {
	token: TokenSet;
	userData: UserinfoResponse;
}

const stringWithDefault = (value: string) =>
	z
		.string()
		.default(value)
		.transform((el) => (el ? el : value));

export const OIDConfig = z
	.object({
		CLIENT_ID: stringWithDefault(config.OPENID_CLIENT_ID),
		CLIENT_SECRET: stringWithDefault(config.OPENID_CLIENT_SECRET),
		PROVIDER_URL: stringWithDefault(config.OPENID_PROVIDER_URL),
		SCOPES: stringWithDefault(config.OPENID_SCOPES),
		NAME_CLAIM: stringWithDefault(config.OPENID_NAME_CLAIM).refine(
			(el) => !["preferred_username", "email", "picture", "sub"].includes(el),
			{ message: "nameClaim cannot be one of the restricted keys." }
		),
		TOLERANCE: stringWithDefault(config.OPENID_TOLERANCE),
		RESOURCE: stringWithDefault(config.OPENID_RESOURCE),
		ID_TOKEN_SIGNED_RESPONSE_ALG: z.string().optional(),
	})
	.parse(JSON5.parse(config.OPENID_CONFIG || "{}"));

export const loginEnabled = !!OIDConfig.CLIENT_ID;

export const secure = z
	.boolean()
	.default(!(dev || config.ALLOW_INSECURE_COOKIES === "true"))
	.parse(config.COOKIE_SECURE === "" ? undefined : config.COOKIE_SECURE === "true");

export const sameSite = z
	.enum(["lax", "none", "strict"])
	.default(!secure || dev || config.ALLOW_INSECURE_COOKIES === "true" ? "lax" : "none")
	.parse(config.COOKIE_SAMESITE === "" ? undefined : config.COOKIE_SAMESITE);

/**
 * Secret used to seal the session cookie (iron-session) and to sign CSRF tokens.
 * iron-session requires at least 32 characters. We only hard-require it when login
 * is enabled (anonymous-only deployments never seal a session).
 */
export const SESSION_SECRET = config.SESSION_SECRET ?? "";
if (loginEnabled && SESSION_SECRET.length < 32) {
	throw new Error(
		"SESSION_SECRET must be set to at least 32 characters when login (OPENID_CLIENT_ID) is enabled."
	);
}

const COOKIE_OPTS = {
	path: "/",
	sameSite,
	secure,
	httpOnly: true,
} as const;

/** Data sealed into the session cookie. No server-side store backs it. */
export interface SessionData {
	user: {
		hfUserId: string;
		username?: string;
		name: string;
		email?: string;
		avatarUrl: string;
	};
	oauth?: {
		accessToken: string;
		refreshToken?: string;
		/** epoch ms; access token treated as expired shortly before this */
		expiresAt: number;
	};
}

export function sanitizeReturnPath(path: string | undefined | null): string | undefined {
	if (!path) {
		return undefined;
	}
	if (path.startsWith("//")) {
		return undefined;
	}
	if (!path.startsWith("/")) {
		return undefined;
	}
	return path;
}

/**
 * One-shot guard used when restarting the OAuth flow after a callback that was started
 * in another browser (e.g. "Open in Safari" from an in-app browser). Prevents redirect loops.
 */
const loginRetryCookieName = "hfChat-loginRetry";

export function hasLoginRetryCookie(cookies: Cookies): boolean {
	return cookies.get(loginRetryCookieName) === "1";
}

export function setLoginRetryCookie(cookies: Cookies) {
	cookies.set(loginRetryCookieName, "1", {
		path: "/",
		// `strict` would keep this cookie from being sent on the cross-site IdP -> callback
		// navigation, which is exactly where the loop guard must be observable
		sameSite: sameSite === "strict" ? "lax" : sameSite,
		secure,
		httpOnly: true,
		maxAge: 5 * 60,
	});
}

export function clearLoginRetryCookie(cookies: Cookies) {
	cookies.delete(loginRetryCookieName, { path: "/" });
}

export function refreshSessionCookie(cookies: Cookies, sessionId: string) {
	cookies.set(config.COOKIE_NAME, sessionId, {
		path: "/",
		// So that it works inside the space's iframe
		sameSite,
		secure,
		httpOnly: true,
		expires: addWeeks(new Date(), 2),
	});
}

/** Deterministic ObjectId for a user, derived from the OIDC subject. */
async function userObjectId(hfUserId: string): Promise<ObjectId> {
	return new ObjectId((await sha256(hfUserId)).slice(0, 24));
}

async function sessionDataToUser(data: SessionData): Promise<User> {
	return {
		_id: await userObjectId(data.user.hfUserId),
		hfUserId: data.user.hfUserId,
		username: data.user.username,
		name: data.user.name,
		email: data.user.email,
		avatarUrl: data.user.avatarUrl,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

export function tokenSetToOauth(tokenSet: TokenSet): SessionData["oauth"] | undefined {
	if (!tokenSet.access_token) {
		return undefined;
	}
	return {
		accessToken: tokenSet.access_token,
		refreshToken: tokenSet.refresh_token || undefined,
		// treat as expired one minute early to avoid edge-of-expiry failures
		expiresAt: tokenSet.expires_at
			? tokenSet.expires_at * 1000 - 60_000
			: addWeeks(new Date(), 2).getTime(),
	};
}

/** Seal a session into the cookie. */
export async function setSessionCookie(cookies: Cookies, data: SessionData): Promise<void> {
	const sealed = await sealData(data, { password: SESSION_SECRET, ttl: 60 * 60 * 24 * 14 });
	cookies.set(config.COOKIE_NAME, sealed, { ...COOKIE_OPTS, expires: addWeeks(new Date(), 2) });
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(config.COOKIE_NAME, COOKIE_OPTS);
}

async function readSessionCookie(cookies: Cookies): Promise<SessionData | null> {
	const sealed = cookies.get(config.COOKIE_NAME);
	if (!sealed) return null;
	try {
		const data = await unsealData<SessionData>(sealed, { password: SESSION_SECRET });
		return data && data.user ? data : null;
	} catch {
		return null;
	}
}

// Dedupe concurrent refreshes for the same user within this instance (replaces the
// MongoDB semaphore lock). Self-hosted runs a single instance, so this is enough.
const refreshInFlight = new Map<string, Promise<SessionData["oauth"] | null>>();

async function maybeRefresh(data: SessionData, url: URL): Promise<SessionData | null> {
	const oauth = data.oauth;
	if (!oauth) return data;

	const expiresInMin = differenceInMinutes(new Date(oauth.expiresAt), new Date());
	if (expiresInMin >= 5) return data;

	if (!oauth.refreshToken) {
		// expired and unrefreshable
		return Date.now() > oauth.expiresAt ? null : data;
	}

	const key = data.user.hfUserId;
	let pending = refreshInFlight.get(key);
	if (!pending) {
		pending = (async () => {
			const tokenSet = await refreshOAuthToken(
				{ redirectURI: `${config.PUBLIC_ORIGIN}${base}/login/callback` },
				oauth.refreshToken as string,
				url
			).catch((err) => {
				logger.error(err, "Error refreshing OAuth token");
				return null;
			});
			return tokenSet ? tokenSetToOauth(tokenSet) : null;
		})().finally(() => refreshInFlight.delete(key));
		refreshInFlight.set(key, pending);
	}

	const refreshed = await pending;
	if (!refreshed) {
		return Date.now() > oauth.expiresAt ? null : data;
	}
	return { ...data, oauth: refreshed };
}

/**
 * Resolve the request's identity from the sealed cookie (or a trusted email
 * header). Refreshes and re-seals the session when the OAuth token is near expiry.
 * No database is involved.
 */
export async function authenticateRequest(
	headers: Headers,
	cookies: Cookies,
	url: URL
): Promise<{ user?: User; token?: string }> {
	if (config.TRUSTED_EMAIL_HEADER) {
		const email = headers.get(config.TRUSTED_EMAIL_HEADER);
		if (email) {
			return {
				user: {
					_id: await userObjectId(email),
					name: email,
					email,
					hfUserId: email,
					avatarUrl: "",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			};
		}
	}

	const data = await readSessionCookie(cookies);
	if (!data) return { user: undefined };

	const refreshed = await maybeRefresh(data, url);
	if (!refreshed) {
		clearSessionCookie(cookies);
		return { user: undefined };
	}

	// Re-seal if the token changed during refresh.
	if (refreshed.oauth?.accessToken !== data.oauth?.accessToken) {
		await setSessionCookie(cookies, refreshed);
	}

	return { user: await sessionDataToUser(refreshed), token: refreshed.oauth?.accessToken };
}

/**
 * CSRF token signed with the server secret (replaces the per-session-id signature;
 * the PKCE codeVerifier cookie provides the real per-flow binding).
 */
async function generateCsrfToken(redirectUrl: string, next?: string): Promise<string> {
	const sanitizedNext = sanitizeReturnPath(next);
	const data = {
		expiration: addHours(new Date(), 1).getTime(),
		redirectUrl,
		...(sanitizedNext ? { next: sanitizedNext } : {}),
	} as {
		expiration: number;
		redirectUrl: string;
		next?: string;
	};

	return Buffer.from(
		JSON.stringify({
			data,
			signature: await sha256(JSON.stringify(data) + "##" + SESSION_SECRET),
		})
	).toString("base64");
}

let lastIssuer: Issuer<BaseClient> | null = null;
let lastIssuerFetchedAt: Date | null = null;
async function getOIDCClient(settings: OIDCSettings, url: URL): Promise<BaseClient> {
	if (
		lastIssuer &&
		lastIssuerFetchedAt &&
		differenceInMinutes(new Date(), lastIssuerFetchedAt) >= 10
	) {
		lastIssuer = null;
		lastIssuerFetchedAt = null;
	}
	if (!lastIssuer) {
		lastIssuer = await Issuer.discover(OIDConfig.PROVIDER_URL);
		lastIssuerFetchedAt = new Date();
	}

	const issuer = lastIssuer;

	const client_config: ConstructorParameters<typeof issuer.Client>[0] = {
		client_id: OIDConfig.CLIENT_ID,
		client_secret: OIDConfig.CLIENT_SECRET,
		redirect_uris: [settings.redirectURI],
		response_types: ["code"],
		[custom.clock_tolerance]: OIDConfig.TOLERANCE || undefined,
		id_token_signed_response_alg: OIDConfig.ID_TOKEN_SIGNED_RESPONSE_ALG || undefined,
	};

	if (OIDConfig.CLIENT_ID === "__CIMD__") {
		// See https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
		client_config.client_id = new URL(
			`${base}/.well-known/oauth-cimd`,
			config.PUBLIC_ORIGIN || url.origin
		).toString();
	}

	const alg_supported = issuer.metadata["id_token_signing_alg_values_supported"];

	if (Array.isArray(alg_supported)) {
		client_config.id_token_signed_response_alg ??= alg_supported[0];
	}

	return new issuer.Client(client_config);
}

export async function getOIDCAuthorizationUrl(
	settings: OIDCSettings,
	params: { next?: string; url: URL; cookies: Cookies }
): Promise<string> {
	const client = await getOIDCClient(settings, params.url);
	const csrfToken = await generateCsrfToken(settings.redirectURI, sanitizeReturnPath(params.next));

	const codeVerifier = generators.codeVerifier();
	const codeChallenge = generators.codeChallenge(codeVerifier);

	params.cookies.set("hfChat-codeVerifier", codeVerifier, {
		...COOKIE_OPTS,
		expires: addHours(new Date(), 1),
	});

	return client.authorizationUrl({
		code_challenge_method: "S256",
		code_challenge: codeChallenge,
		scope: OIDConfig.SCOPES,
		state: csrfToken,
		resource: OIDConfig.RESOURCE || undefined,
	});
}

export async function getOIDCUserData(
	settings: OIDCSettings,
	code: string,
	codeVerifier: string,
	iss: string | undefined,
	url: URL
): Promise<OIDCUserInfo> {
	const client = await getOIDCClient(settings, url);
	const token = await client.callback(
		settings.redirectURI,
		{
			code,
			iss,
		},
		{ code_verifier: codeVerifier }
	);
	const userData = await client.userinfo(token);

	return { token, userData };
}

/**
 * Refreshes an OAuth token using the refresh token
 */
export async function refreshOAuthToken(
	settings: OIDCSettings,
	refreshToken: string,
	url: URL
): Promise<TokenSet | null> {
	const client = await getOIDCClient(settings, url);
	const tokenSet = await client.refresh(refreshToken);
	return tokenSet;
}

export async function validateAndParseCsrfToken(token: string): Promise<{
	/** This is the redirect url that was passed to the OIDC provider */
	redirectUrl: string;
	/** Relative path (within this app) to return to after login */
	next?: string;
} | null> {
	try {
		const { data, signature } = z
			.object({
				data: z.object({
					expiration: z.number().int(),
					redirectUrl: z.string().url(),
					next: z.string().optional(),
				}),
				signature: z.string().length(64),
			})
			.parse(JSON.parse(token));

		const reconstructSign = await sha256(JSON.stringify(data) + "##" + SESSION_SECRET);

		if (data.expiration > Date.now() && signature === reconstructSign) {
			return { redirectUrl: data.redirectUrl, next: sanitizeReturnPath(data.next) };
		}
	} catch (e) {
		logger.error(e, "Error validating and parsing CSRF token");
	}
	return null;
}

export async function triggerOauthFlow({ url, cookies }: RequestEvent): Promise<Response> {
	let redirectURI = `${url.origin}${base}/login/callback`;

	if (url.searchParams.has("callback")) {
		const callback = url.searchParams.get("callback") || redirectURI;
		if (config.ALTERNATIVE_REDIRECT_URLS.includes(callback)) {
			redirectURI = callback;
		}
	}

	// Preserve a safe in-app return path after login.
	let next: string | undefined = undefined;
	const nextParam = sanitizeReturnPath(url.searchParams.get("next"));
	if (nextParam) {
		next = nextParam;
	} else if (!url.pathname.startsWith(`${base}/login`)) {
		next = sanitizeReturnPath(`${url.pathname}${url.search}`) ?? `${base}/`;
	} else {
		next = sanitizeReturnPath(`${base}/`) ?? "/";
	}

	const authorizationUrl = await getOIDCAuthorizationUrl({ redirectURI }, { next, url, cookies });

	throw redirect(302, authorizationUrl);
}
