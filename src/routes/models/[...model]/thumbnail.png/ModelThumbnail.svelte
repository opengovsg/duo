<script lang="ts">
	interface Props {
		name: string;
	}

	let { name }: Props = $props();
</script>

<!-- This is rendered to an image by satori, which honors inline styles but not the
	Tailwind classes, so the centering has to be inline (and the <h1> below must not be
	w-full, or it stretches and the name sticks to the left edge). The classes are kept
	so the markup still reads correctly. -->
<div
	class=" flex h-[648px] w-full flex-col items-center justify-center bg-black px-16 text-center text-white"
>
	<h1 class="mb-8 text-7xl font-bold text-white">
		{name}
	</h1>
</div>
