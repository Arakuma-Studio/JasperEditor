import { ChildProcess, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { startHeadlessEngine } from '../src/discovery.ts';

vi.mock('node:child_process', async () => ({
	...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
	fork: vi.fn(),
}));

it('rejects engine spawn errors without emitting an unhandled child error', async () => {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-start-'));
	const child = new ChildProcess();
	vi.mocked(fork).mockReturnValue(child);
	try {
		const pending = startHeadlessEngine({ entry: '/engine.mjs', appdir });
		const rejected = expect(pending).rejects.toThrow('spawn failed');
		child.emit('error', new Error('spawn failed'));
		await rejected;
	} finally {
		rmSync(appdir, { recursive: true, force: true });
	}
});

it('an engine that exits before it is ready rejects with its exit code and the end of its output', async () => {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-start-'));
	const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
	vi.mocked(fork).mockReturnValue(child);
	try {
		const pending = startHeadlessEngine({ entry: '/engine.mjs', appdir, log: () => {} });
		const rejected = expect(pending).rejects.toMatchObject({
			code: 'ENGINE_START_FAILED',
			message: expect.stringMatching(/exited with code 3 before it was ready[\s\S]*ffmpeg not found/),
			details: { exitCode: 3 },
		});
		child.stderr.write('[engine] failed to start: ffmpeg not found\n');
		await new Promise((r) => setImmediate(r));
		child.emit('exit', 3, null);
		await rejected;
	} finally {
		rmSync(appdir, { recursive: true, force: true });
	}
});
