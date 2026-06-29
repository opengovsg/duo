import { base } from "$app/paths";
import { redirect } from "@sveltejs/kit";
import { clearSessionCookie } from "$lib/server/auth";

export async function POST({ cookies }) {
	// Stateless sessions: clearing the sealed cookie is the entire logout.
	// The client clears its IndexedDB conversation cache separately.
	clearSessionCookie(cookies);
	return redirect(302, `${base}/`);
}
