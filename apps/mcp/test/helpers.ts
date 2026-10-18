import { createServer } from 'node:net';

export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && !key.startsWith('JASPER_')) env[key] = value;
	return { ...env, JASPER_CACHE_AUTO_GC: '0', ...extra };
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

/**
 * A free loopback port for a test's own engine. The suite's files run in parallel workers and other checkouts run
 * the same suite on the same machine, so a fixed default port could be taken by another file's engine: the test
 * then talked to an engine on a different appdir (jasper-mcp: ENGINE_NOT_FOUND). `override` (the file's
 * MCP_*_TEST_PORT) still pins one.
 */
export async function testPort(override?: string): Promise<number> {
	if (override) return Number(override);
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() =>
				typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
			);
		});
	});
}
