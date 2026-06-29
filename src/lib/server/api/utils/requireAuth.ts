import { error } from "@sveltejs/kit";

/**
 * Throws 401 if there is no authenticated user in locals.
 * (Stateless sessions: identity comes from the sealed cookie; there is no
 * anonymous server-side sessionId anymore.)
 */
export function requireAuth(locals: App.Locals): void {
	if (!locals.user?._id) {
		error(401, "Must be logged in");
	}
}
