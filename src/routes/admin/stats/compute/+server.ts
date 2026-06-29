import { json } from "@sveltejs/kit";
import { logger } from "$lib/server/logger";
import { config } from "$lib/server/config";
import { computeAllStats } from "$lib/jobs/refresh-conversation-stats";

// Triger like this:
// curl -X POST "http://localhost:5173/chat/admin/stats/compute" -H "Authorization: Bearer <ADMIN_API_SECRET>"

export async function POST() {
	// In client-state mode conversations are never stored server-side, so there is
	// nothing to aggregate. Live counts come from the Prometheus metrics instead.
	if (config.isStateClient) {
		return json(
			{ message: "Conversation stats are unavailable in client-state mode (no server storage)." },
			{ status: 501 }
		);
	}
	computeAllStats().catch((e) => logger.error(e, "Error computing all stats"));
	return json(
		{
			message: "Stats job started",
		},
		{ status: 202 }
	);
}
