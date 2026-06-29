import { browser } from "$app/environment";
import type { ReasoningEffort, StreamingMode } from "$lib/types/Settings";
import { getContext, setContext } from "svelte";
import { type Writable, writable, get } from "svelte/store";

// Database-free build: settings always live in localStorage, never the server.
const SETTINGS_LOCAL_KEY = "chat-ui-settings";

function persistSettingsLocally(settings: unknown) {
	if (!browser) return;
	try {
		localStorage.setItem(SETTINGS_LOCAL_KEY, JSON.stringify(settings));
	} catch {
		// quota / private-mode errors are non-fatal
	}
}

function loadSettingsLocally(): Record<string, unknown> | undefined {
	if (!browser) return undefined;
	try {
		const raw = localStorage.getItem(SETTINGS_LOCAL_KEY);
		return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

type SettingsStore = {
	shareConversationsWithModelAuthors: boolean;
	welcomeModalSeen: boolean;
	welcomeModalSeenAt: Date | null;
	activeModel: string;
	customPrompts: Record<string, string>;
	customPromptsEnabled: Record<string, boolean>;
	multimodalOverrides: Record<string, boolean>;
	toolsOverrides: Record<string, boolean>;
	artifactsOverrides: Record<string, boolean>;
	hidePromptExamples: Record<string, boolean>;
	providerOverrides: Record<string, string>;
	reasoningEffortOverrides: Record<string, ReasoningEffort>;
	reasoningOverrides: Record<string, boolean>;
	recentlySaved: boolean;
	streamingMode: StreamingMode;
	directPaste: boolean;
	hapticsEnabled: boolean;
	billingOrganization?: string;
};

type SettingsStoreWritable = Writable<SettingsStore> & {
	instantSet: (settings: Partial<SettingsStore>) => Promise<void>;
	initValue: <K extends keyof SettingsStore>(
		key: K,
		nestedKey: string,
		value: string | boolean
	) => Promise<void>;
};

export function useSettingsStore() {
	return getContext<SettingsStoreWritable>("settings");
}

export function createSettingsStore(initialValue: Omit<SettingsStore, "recentlySaved">) {
	// Client-state mode: hydrate from localStorage over the server defaults so
	// the user's saved preferences survive reloads without a database.
	const seeded = browser ? { ...initialValue, ...(loadSettingsLocally() ?? {}) } : initialValue;
	const baseStore = writable({ ...seeded, recentlySaved: false });

	let timeoutId: NodeJS.Timeout;
	let showSavedOnNextSync = false;

	async function setSettings(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			showSavedOnNextSync = true; // User edit, should show "Saved"
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				persistSettingsLocally(get(baseStore));

				if (showSavedOnNextSync) {
					// set savedRecently to true for 3s
					baseStore.update((s) => ({
						...s,
						recentlySaved: true,
					}));
					setTimeout(() => {
						baseStore.update((s) => ({
							...s,
							recentlySaved: false,
						}));
					}, 3000);
				}

				showSavedOnNextSync = false;
			}, 300);
			// debounce server calls by 300ms
		}
	}

	async function initValue<K extends keyof SettingsStore>(
		key: K,
		nestedKey: string,
		value: string | boolean
	) {
		const currentStore = get(baseStore);
		const currentNestedObject = currentStore[key] as Record<string, string | boolean>;

		// Only initialize if undefined
		if (currentNestedObject?.[nestedKey] !== undefined) {
			return;
		}

		// Update the store
		const newNestedObject = {
			...(currentNestedObject || {}),
			[nestedKey]: value,
		};

		baseStore.update((s) => ({
			...s,
			[key]: newNestedObject,
		}));

		// Save to server (debounced) - note: we don't set showSavedOnNextSync
		if (browser) {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				persistSettingsLocally(get(baseStore));

				if (showSavedOnNextSync) {
					baseStore.update((s) => ({
						...s,
						recentlySaved: true,
					}));
					setTimeout(() => {
						baseStore.update((s) => ({
							...s,
							recentlySaved: false,
						}));
					}, 3000);
				}

				showSavedOnNextSync = false;
			}, 300);
		}
	}
	async function instantSet(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			persistSettingsLocally({ ...get(baseStore), ...settings });
		}
	}

	const newStore = {
		subscribe: baseStore.subscribe,
		set: setSettings,
		instantSet,
		initValue,
		update: (fn: (s: SettingsStore) => SettingsStore) => {
			setSettings(fn(get(baseStore)));
		},
	} satisfies SettingsStoreWritable;

	setContext("settings", newStore);

	return newStore;
}
