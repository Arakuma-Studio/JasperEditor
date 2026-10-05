export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && !key.startsWith('JASPER_')) env[key] = value;
	return { ...env, ...extra };
}

export async function waitFor(
	check: () => Promise<boolean> | boolean,
	timeoutMs: number,
	description: string,
) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (
			await Promise.resolve()
				.then(check)
				.catch(() => false)
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${description}`);
}
