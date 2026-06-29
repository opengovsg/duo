import { env as publicEnv } from "$env/dynamic/public";
import { env as serverEnv } from "$env/dynamic/private";
import { building } from "$app/environment";

export type PublicConfigKey = keyof typeof publicEnv;
const keysFromEnv = { ...publicEnv, ...serverEnv };
export type ConfigKey = keyof typeof keysFromEnv;

/**
 * Env-only configuration. This deployment is database-free, so there is no
 * runtime (MongoDB-backed) config manager — values come straight from the
 * environment.
 */
class ConfigManager {
	private isInitialized = false;

	async init() {
		this.isInitialized = true;
	}

	get isHuggingChat() {
		return this.get("PUBLIC_APP_ASSETS") === "huggingchat";
	}

	// Kept as a no-op so callers (e.g. the request hook) don't need to branch.
	async checkForUpdates() {}

	get(key: ConfigKey): string {
		return keysFromEnv[key] || "";
	}

	getPublicConfig() {
		const publicEnvKeys = Object.keys(publicEnv);
		return Object.fromEntries(
			Object.entries(keysFromEnv).filter(([key]) => publicEnvKeys.includes(key))
		) as Record<PublicConfigKey, string>;
	}
}

// Create the instance and initialize it.
const configManager = new ConfigManager();

export const ready = (async () => {
	if (!building) {
		await configManager.init();
	}
})();

type ExtraConfigKeys =
	| "HF_TOKEN"
	| "OLD_MODELS"
	| "ENABLE_ASSISTANTS"
	| "METRICS_ENABLED"
	| "METRICS_PORT"
	| "MCP_SERVERS"
	| "MCP_FORWARD_HF_USER_TOKEN"
	| "MCP_TOOL_TIMEOUT_MS"
	| "EXA_API_KEY"
	| "SESSION_SECRET";

type ConfigProxy = ConfigManager & { [K in ConfigKey | ExtraConfigKeys]: string };

export const config: ConfigProxy = new Proxy(configManager, {
	get(target, prop, receiver) {
		if (prop in target) {
			return Reflect.get(target, prop, receiver);
		}
		if (typeof prop === "string") {
			return target.get(prop as ConfigKey);
		}
		return undefined;
	},
}) as ConfigProxy;
