import { ChildProcess, fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
