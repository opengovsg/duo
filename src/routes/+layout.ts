import type { ConvSidebar } from "$lib/types/ConvSidebar";
import { useAPIClient, handleResponse } from "$lib/APIClient";
import { getConfigManager } from "$lib/utils/PublicConfig.svelte";
import type { GETModelsResponse, FeatureFlags } from "$lib/server/api/types";
import { base } from "$app/paths";

interface UserInfo {
	id: string;
	username?: string;
	avatarUrl?: string;
	email?: string;
	isAdmin: boolean;
	isEarlyAccess: boolean;
}

interface SettingsResponse {
	welcomeModalSeen: boolean;
	welcomeModalSeenAt: Date | null;
	shareConversationsWithModelAuthors: boolean;
	activeModel: string;
	streamingMode: "raw" | "smooth";
	directPaste: boolean;
	hapticsEnabled: boolean;
	customPrompts: Record<string, string>;
	customPromptsEnabled: Record<string, boolean>;
	multimodalOverrides: Record<string, boolean>;
	toolsOverrides: Record<string, boolean>;
	artifactsOverrides: Record<string, boolean>;
	hidePromptExamples: Record<string, boolean>;
	providerOverrides: Record<string, string>;
	reasoningEffortOverrides: Record<string, "low" | "medium" | "high">;
	reasoningOverrides: Record<string, boolean>;
	billingOrganization?: string;
}

export const load = async ({ fetch, url }) => {
	const client = useAPIClient({ fetch, origin: url.origin });

	// Fetch the MCP base-server list alongside the other layout data.
	// During SSR, SvelteKit's fetch intercepts same-origin requests and serves
	// them directly from the handler — no real HTTP round-trip. The result is
	// inlined in the SSR payload so the client has it before any onMount fires,
	// allowing +layout.svelte to pre-populate the mcpServers store synchronously
	// and eliminate the mcpServersLoaded gate delay on first message.
	// Database-free: conversations + settings live in the browser (IndexedDB /
	// localStorage), so they are NOT fetched from the server here. Identity still
	// comes from the server (sealed session cookie) via /api/v2/user.
	const [models, user, publicConfig, featureFlags, mcpBaseServers] = (await Promise.all([
		client.models.get().then(handleResponse),
		client.user.get().then(handleResponse),
		client["public-config"].get().then(handleResponse),
		client["feature-flags"].get().then(handleResponse),
		fetch(`${url.origin}${base}/api/mcp/servers`)
			.then((r) => (r.ok ? r.json() : []))
			.catch(() => []),
	])) as [
		GETModelsResponse,
		UserInfo | null,
		Record<string, unknown>,
		FeatureFlags,
		import("$lib/types/Tool").MCPServer[],
	];

	const defaultModel = models[0];

	// Client-side default settings; the settings store hydrates over these from
	// localStorage on the client.
	const settings: SettingsResponse = {
		welcomeModalSeen: false,
		welcomeModalSeenAt: null,
		shareConversationsWithModelAuthors: true,
		activeModel: defaultModel?.id ?? "",
		streamingMode: "smooth",
		directPaste: false,
		hapticsEnabled: true,
		customPrompts: {},
		customPromptsEnabled: {},
		multimodalOverrides: {},
		toolsOverrides: {},
		artifactsOverrides: {},
		hidePromptExamples: {},
		providerOverrides: {},
		reasoningEffortOverrides: {},
		reasoningOverrides: {},
	};

	return {
		conversations: [] as ConvSidebar[],
		models,
		oldModels: [],
		user,
		settings,
		publicConfig: getConfigManager(publicConfig as Record<`PUBLIC_${string}`, string>),
		mcpBaseServers,
		...featureFlags,
	};
};
