<script lang="ts">
	import Modal from "$lib/components/Modal.svelte";
	import Logo from "$lib/components/icons/Logo.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		close: () => void;
	}

	let { close }: Props = $props();
</script>

<Modal closeOnBackdrop={false} onclose={close} width="max-w-[420px]! m-4!">
	<div
		class="flex w-full flex-col gap-8 bg-white bg-linear-to-b to-transparent px-6 pb-7 dark:bg-black dark:from-white/10 dark:to-white/5"
	>
		<div
			class="relative -mx-6 grid h-48 place-items-center overflow-hidden rounded-b-xl bg-linear-to-t from-black/5 select-none dark:from-white/10"
		>
			<h2
				class="flex translate-y-1 items-center text-3xl font-semibold text-gray-900 dark:text-gray-100"
			>
				<Logo classNames="mr-2 size-12 dark:invert" />
				{publicConfig.PUBLIC_APP_NAME}
			</h2>
		</div>

		<div class="text-gray-700 dark:text-gray-200">
			<p class="text-[15px] leading-relaxed">
				Welcome to {publicConfig.PUBLIC_APP_NAME}, an open-source AI chat app.
			</p>
		</div>

		<button
			class="k w-full rounded-xl bg-black px-5 py-2.5 text-base font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200"
			onclick={close}
		>
			Start chatting
		</button>
	</div>
</Modal>
