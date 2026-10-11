// Bundle src/cli.ts exactly as the release build does: mixing dynamic and static package imports can break initialization.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, expect, it } from 'vitest';
import { BUILD_OPTIONS } from '../scripts/build-options.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-bundle-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('the jasper-mcp bundle loads and answers initialize', async () => {
	const outfile = join(dir, 'jasper-mcp.mjs');
	await build({ ...BUILD_OPTIONS, entryPoints: [join(root, 'src/cli.ts')], outfile, logLevel: 'silent' });
	const child = spawn(process.execPath, [outfile, '--appdir', join(dir, 'appdir')], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let out = '';
	let err = '';
	child.stdout.on('data', (d: Buffer) => {
		out += d.toString('utf8');
	});
	child.stderr.on('data', (d: Buffer) => {
		err += d.toString('utf8');
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
		await expect
			.poll(() => out.includes('"id":1') || child.exitCode !== null, { timeout: 30_000 })
			.toBe(true);
		expect(child.exitCode, err).toBeNull();
		const reply = JSON.parse(out.split('\n').find((l) => l.includes('"id":1'))!);
		expect(reply.result.serverInfo.name).toBe('jasper-editor');
	} finally {
		child.kill();
	}
});
