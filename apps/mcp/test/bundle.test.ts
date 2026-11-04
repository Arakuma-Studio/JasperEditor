// Bundle src/cli.ts exactly as the release build does: mixing dynamic and static package imports can break initialization.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, expect, it } from 'vitest';
import { BUILD_OPTIONS } from '../scripts/build-options.mjs';
import { stopEngine } from './helpers.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-bundle-'));
let activeChild: ChildProcess | null = null;
afterAll(async () => {
	try {
		await stopEngine(activeChild);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it('the jasper-mcp bundle loads and answers initialize', async () => {
	const outfile = join(dir, 'jasper-mcp.mjs');
	await build({ ...BUILD_OPTIONS, entryPoints: [join(root, 'src/cli.ts')], outfile, logLevel: 'silent' });
	const child = spawn(process.execPath, [outfile, '--appdir', join(dir, 'appdir')], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	activeChild = child;
	let err = '';
	child.stderr.on('data', (d: Buffer) => {
		err += d.toString('utf8');
	});
	const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
	const initialized = new Promise<{ result: { serverInfo: { name: string } } }>((resolve, reject) => {
		const lines = createInterface({ input: child.stdout });
		const cleanup = () => {
			lines.close();
			child.off('error', fail);
			child.off('close', exited);
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const exited = (code: number | null, signal: NodeJS.Signals | null) =>
			fail(new Error(`MCP bundle exited before initialize (${code ?? signal}): ${err}`));
		child.once('error', fail);
		child.once('close', exited);
		lines.on('line', (line) => {
			try {
				const reply = JSON.parse(line);
				if (reply.id === 1) {
					cleanup();
					resolve(reply);
				}
			} catch (error) {
				fail(error as Error);
			}
		});
	});
	child.stdin.write(
		`${JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'bundle-test', version: '1' },
			},
		})}\n`,
	);
	try {
		const reply = await initialized;
		expect(child.exitCode, err).toBeNull();
		expect(reply.result.serverInfo.name).toBe('jasper-editor');
	} finally {
		await stopEngine(child);
		await closed;
		activeChild = null;
	}
});
