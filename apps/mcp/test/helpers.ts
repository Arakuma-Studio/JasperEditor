import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * The environment of a spawned engine or jasper-mcp: none of the caller's JASPER_* settings, cache GC off, and
 * every toolset advertised (the suites call tools of every toolset; toolsets.test.ts covers the core default).
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && !key.startsWith('JASPER_')) env[key] = value;
	return { ...env, JASPER_CACHE_AUTO_GC: '0', JASPER_MCP_TOOLSETS: 'all', ...extra };
}

/** The CLI announces its bound port; verify its HTTP endpoint before starting a client. */
export async function engineReady(child: ChildProcess, port: number, logs: readonly string[] = []) {
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				child.removeListener('message', message);
				child.removeListener('error', failed);
				child.removeListener('exit', exited);
				if (error) reject(error);
				else resolve();
			};
			const message = (value: unknown) => {
				if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'ready') return;
				const actual = (value as { port?: unknown }).port;
				finish(
					actual === port
						? undefined
						: new Error(`Engine announced port ${String(actual)}, expected ${port}`),
				);
			};
			const failed = (error: Error) => finish(error);
			const exited = (code: number | null, signal: NodeJS.Signals | null) =>
				finish(new Error(`Engine exited before readiness (${signal ?? code})`));
			child.on('message', message);
			child.once('error', failed);
			child.once('exit', exited);
			if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode);
		});
		const health = await fetch(`http://127.0.0.1:${port}/health`);
		if (!health.ok) throw new Error(`Engine health returned HTTP ${health.status}`);
	} catch (error) {
		await stopEngine(child);
		throw new Error(`Engine on ${port} did not become ready: ${logs.join('')}`, { cause: error });
	}
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

/** Reaps the fixture engine; exceeding its eight-second SIGTERM grace period is a test failure. */
export async function stopEngine(child: ChildProcess | null): Promise<void> {
	if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	let onExit!: () => void;
	const exited = new Promise<void>((resolve) => {
		onExit = resolve;
		child.once('exit', onExit);
	});
	try {
		child.kill('SIGTERM');
		await Promise.race([
			exited,
			new Promise<void>((resolve) => {
				timeout = setTimeout(() => {
					timedOut = true;
					resolve();
				}, 8000);
			}),
		]);
		if (timedOut) {
			child.kill('SIGKILL');
			await exited;
			throw new Error('Fixture engine did not exit within 8000 ms after SIGTERM; SIGKILL was required');
		}
	} finally {
		clearTimeout(timeout);
		child.removeListener('exit', onExit);
	}
}
