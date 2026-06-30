<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$app/paths";

	import type { BackendModel } from "$lib/server/models";
	import IconOmni from "$lib/components/icons/IconOmni.svelte";
	import { useSettingsStore } from "$lib/stores/settings";
	import CarbonArrowUpRight from "~icons/carbon/arrow-up-right";
	import CarbonChat from "~icons/carbon/chat";
	import CarbonReset from "~icons/carbon/reset";

	import { goto } from "$app/navigation";
	import Switch from "$lib/components/Switch.svelte";

	const settings = useSettingsStore();
	const modelId = $derived(page.params.model ?? "");

	// Functional bindings for nested settings (Svelte 5):
	// Avoid binding directly to $settings.*[modelId]; write via store update
	function getToolsOverride() {
		return (
			$settings.toolsOverrides?.[modelId] ??
			Boolean((model as unknown as { supportsTools?: boolean }).supportsTools)
		);
	}
	function setToolsOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			toolsOverrides: { ...s.toolsOverrides, [modelId]: v },
		}));
	}
	function getMultimodalOverride() {
		return $settings.multimodalOverrides?.[modelId] ?? Boolean(model?.multimodal);
	}
	function setMultimodalOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			multimodalOverrides: { ...s.multimodalOverrides, [modelId]: v },
		}));
	}
	function getHidePromptExamples() {
		return $settings.hidePromptExamples?.[modelId] ?? false;
	}
	function setHidePromptExamples(v: boolean) {
		settings.update((s) => ({
			...s,
			hidePromptExamples: { ...s.hidePromptExamples, [modelId]: v },
		}));
	}

	function getReasoningOverride() {
		return $settings.reasoningOverrides?.[modelId] ?? Boolean(model?.supportsReasoning);
	}
	function setReasoningOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			reasoningOverrides: { ...s.reasoningOverrides, [modelId]: v },
		}));
	}

	function getArtifactsOverride() {
		return $settings.artifactsOverrides?.[modelId] ?? Boolean(model?.supportsArtifacts);
	}
	function setArtifactsOverride(v: boolean) {
		settings.update((s) => ({
			...s,
			artifactsOverrides: { ...s.artifactsOverrides, [modelId]: v },
		}));
	}

	function getCustomPrompt() {
		return $settings.customPrompts?.[modelId] ?? "";
	}
	function setCustomPrompt(v: string) {
		settings.update((s) => ({
			...s,
			customPrompts: { ...s.customPrompts, [modelId]: v },
		}));
	}
	function getCustomPromptEnabled() {
		return $settings.customPromptsEnabled?.[modelId] ?? true;
	}
	function setCustomPromptEnabled(v: boolean) {
		settings.update((s) => ({
			...s,
			customPromptsEnabled: { ...s.customPromptsEnabled, [modelId]: v },
		}));
	}

	$effect(() => {
		const defaultPreprompt =
			page.data.models.find((el: BackendModel) => el.id === modelId)?.preprompt || "";
		settings.initValue("customPrompts", modelId, defaultPreprompt);
	});

	let hasCustomPreprompt = $derived(
		$settings.customPrompts[modelId] !==
			page.data.models.find((el: BackendModel) => el.id === modelId)?.preprompt
	);

	let model = $derived(page.data.models.find((el: BackendModel) => el.id === modelId));

	// multimodalOverrides/toolsOverrides intentionally have no initValue: getters fall back
	// to the model's advertised capability, so upstream capability changes flow through.

	// Ensure hidePromptExamples has an entry for this model so the switch can bind safely
	$effect(() => {
		settings.initValue("hidePromptExamples", modelId, false);
	});

	// Ensure customPromptsEnabled has an entry for this model (default enabled)
	$effect(() => {
		settings.initValue("customPromptsEnabled", modelId, true);
	});

	// Initialize provider override for this model (default to "auto")
	$effect(() => {
		settings.initValue("providerOverrides", modelId, "auto");
	});
</script>

<!-- Key on modelId so the DOM is rebuilt when navigating between models:
     reused switches/textareas would otherwise animate to the new model's values -->
{#key modelId}
	<div class="flex flex-col items-start">
		<div class="mb-4 flex flex-col gap-px">
			<h2 class="text-base font-semibold md:text-lg">
				{model.displayName}
			</h2>

			{#if model.description}
				<p class="line-clamp-2 text-sm whitespace-pre-wrap text-gray-600 dark:text-gray-400">
					{model.description}
				</p>
			{/if}
		</div>

		<!-- Actions -->
		<div class="mb-4 flex flex-wrap items-center gap-1.5">
			<button
				class="flex w-fit items-center rounded-full bg-black px-3 py-1.5 text-sm text-white! shadow-xs hover:bg-black/90 dark:bg-white/80 dark:text-gray-900! dark:hover:bg-white/90"
				name="Activate model"
				onclick={(e) => {
					e.stopPropagation();
					settings.instantSet({
						activeModel: modelId,
					});
					goto(`${base}/`);
				}}
			>
				<CarbonChat class="mr-1.5 text-sm" />
				New chat
			</button>

			{#if model.modelUrl}
				<a
					href={model.modelUrl || "https://huggingface.co/" + model.name}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-1 text-sm hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/60"
				>
					<CarbonArrowUpRight class="mr-1.5 shrink-0 text-xs " />
					Model page
				</a>
			{/if}

			{#if model.datasetName || model.datasetUrl}
				<a
					href={model.datasetUrl || "https://huggingface.co/datasets/" + model.datasetName}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-1 text-sm hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/60"
				>
					<CarbonArrowUpRight class="mr-1.5 shrink-0 text-xs " />
					Dataset page
				</a>
			{/if}

			{#if model.websiteUrl}
				<a
					href={model.websiteUrl}
					target="_blank"
					class="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-1 text-sm hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/60"
					rel="noreferrer"
				>
					<CarbonArrowUpRight class="mr-1.5 shrink-0 text-xs " />
					Model website
				</a>
			{/if}
		</div>

		<div class="relative flex w-full flex-col gap-2">
			{#if model?.isRouter}
				<p class="mt-2 mb-3 rounded-lg bg-gray-100 px-3 py-2 text-sm dark:bg-white/5">
					<IconOmni classNames="-translate-y-px" />
					{model.displayName} routes your messages to the best underlying model depending on your request.
				</p>
			{/if}
			<div class="flex w-full flex-row items-center justify-between">
				<h3 class="text-[15px] font-semibold text-gray-800 dark:text-gray-200">System Prompt</h3>
				<div class="flex items-center gap-2">
					<div
						class="flex items-center gap-1.5 text-[11px] font-medium text-gray-600 select-none dark:text-gray-400"
					>
						<span>Enabled</span>
						<Switch
							name="customPromptEnabled"
							size="sm"
							bind:checked={getCustomPromptEnabled, setCustomPromptEnabled}
						/>
					</div>
					{#if hasCustomPreprompt}
						<button
							type="button"
							aria-label="Reset system prompt"
							title="Reset to default"
							class="grid size-6 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200"
							onclick={(e) => {
								e.stopPropagation();
								settings.update((s) => ({
									...s,
									customPrompts: { ...s.customPrompts, [modelId]: model.preprompt },
								}));
							}}
						>
							<CarbonReset class="size-3.5" />
						</button>
					{/if}
				</div>
			</div>

			<textarea
				aria-label="Custom system prompt"
				rows="8"
				disabled={!getCustomPromptEnabled()}
				class="scrollbar-custom w-full resize-none rounded-md border border-gray-200 bg-gray-50 p-2 text-[13px] transition-opacity dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
				class:opacity-30={!getCustomPromptEnabled()}
				bind:value={getCustomPrompt, setCustomPrompt}
			></textarea>
			<!-- Capabilities -->
			<div
				class="mt-3 rounded-xl border border-gray-200 bg-white px-3 shadow-xs dark:border-gray-700 dark:bg-gray-800"
			>
				<div class="divide-y divide-gray-200 dark:divide-gray-700">
					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Tool calling (functions)
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Enable tools and allow the model to call them in chat.
							</p>
						</div>
						<Switch name="forceTools" bind:checked={getToolsOverride, setToolsOverride} />
					</div>

					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Multimodal support (image inputs)
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Enable image uploads and send images to this model.
							</p>
						</div>
						<Switch
							name="forceMultimodal"
							bind:checked={getMultimodalOverride, setMultimodalOverride}
						/>
					</div>

					<div class="flex items-start justify-between py-3">
						<div>
							<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
								Reasoning effort
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Show a Low / Medium / High selector in the chat footer for this model.
							</p>
						</div>
						<Switch
							name="forceReasoning"
							bind:checked={getReasoningOverride, setReasoningOverride}
						/>
					</div>

					<div class="flex items-start justify-between py-3">
						<div>
							<div
								class="flex items-center gap-1.5 text-[13px] font-medium text-gray-800 dark:text-gray-200"
							>
								Artifacts
								<span
									class="rounded-full bg-gray-100 px-1.5 py-px text-[10px] font-semibold text-gray-500 uppercase dark:bg-gray-700 dark:text-gray-400"
								>
									Beta
								</span>
							</div>
							<p class="text-[12px] text-gray-500 dark:text-gray-400">
								Let the model create apps, documents and diagrams in a side panel with live preview.
							</p>
						</div>
						<!-- Not provider-determined, so user-editable even on HuggingChat -->
						<Switch
							name="artifactsOverride"
							bind:checked={getArtifactsOverride, setArtifactsOverride}
						/>
					</div>

					{#if model?.isRouter}
						<div class="flex items-start justify-between py-3">
							<div>
								<div class="text-[13px] font-medium text-gray-800 dark:text-gray-200">
									Hide prompt examples
								</div>
								<p class="text-[12px] text-gray-500 dark:text-gray-400">
									Hide the prompt suggestions above the chat input.
								</p>
							</div>
							<Switch
								name="hidePromptExamples"
								bind:checked={getHidePromptExamples, setHidePromptExamples}
							/>
						</div>
					{/if}
				</div>
			</div>
			<!-- Tokenizer-based token counting disabled in this build -->
		</div>
	</div>
{/key}
