export async function load({ params, parent }) {
	return {
		settings: await parent().then((data) => ({
			...data.settings,
			activeModel: params.model,
		})),
	};
}
