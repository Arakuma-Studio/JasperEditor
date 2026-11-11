import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_HEARTBEAT_INTERVAL_MS, parseEngineRuntimeState } from '@jasper/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startEngine } from '../src/index.ts';
import { startRuntimeFile } from '../src/runtime-file.ts';

// Every runtime-file write, so a test can wait for the heartbeat's (asynchronous) write to land.
const writes = vi.hoisted(() => [] as Promise<void>[]);
vi.mock('../src/tools/fs.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/tools/fs.ts')>();
	return {
		...actual,
		atomicWriteFile: (...args: Parameters<typeof actual.atomicWriteFile>) => {
			const p = actual.atomicWriteFile(...args);
			writes.push(p);
			return p;
		},
	};
});
const settled = () => Promise.all(writes);

const read = (file: string) => parseEngineRuntimeState(JSON.parse(readFileSync(file, 'utf8')));
const base = { host: '127.0.0.1', port: 0, version: '9.9.9', appdir: '/a' };

/** A pid no process has (a child that already exited). */
function deadPid(): number {
	return spawnSync(process.execPath, ['-e', '0']).pid as number;
}

describe('engine runtime file lifecycle', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('says starting with a heartbeat until ready, then ready with the address; never starting again', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const file = join(mkdtempSync(join(tmpdir(), 'jasper-rt-')), 'runtime.json');
		let clock = 1_000;
		const rt = await startRuntimeFile(file, base, { now: () => clock });
		expect(read(file)).toMatchObject({ state: 'starting', pid: process.pid, heartbeatAt: 1_000 });
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

		clock = 2_000;
		await vi.advanceTimersByTimeAsync(ENGINE_HEARTBEAT_INTERVAL_MS);
		await settled();
		expect(read(file)).toMatchObject({ state: 'starting', heartbeatAt: 2_000 });

		clock = 3_000;
		await rt.ready({
			url: 'http://127.0.0.1:5',
			host: '127.0.0.1',
			port: 5,
			token: 't',
			version: '9.9.9',
			appdir: '/a',
		});
		await vi.advanceTimersByTimeAsync(ENGINE_HEARTBEAT_INTERVAL_MS * 3);
		await settled();
		expect(read(file)).toMatchObject({
			state: 'ready',
			url: 'http://127.0.0.1:5',
			token: 't',
			readyAt: 3_000,
		});

		await rt.remove();
		expect(existsSync(file)).toBe(false);
	});

	it('leaves another live engine’s file alone while starting and replaces a dead one’s', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-rt-'));
		const live = join(dir, 'live.json');
		const other = { url: 'http://127.0.0.1:7', port: 7, pid: process.ppid, token: 'theirs' };
		writeFileSync(live, JSON.stringify(other));
		const rt = await startRuntimeFile(live, base);
		expect(read(live)).toMatchObject({ state: 'ready', token: 'theirs' });
		await rt.remove();
		expect(read(live)).toMatchObject({ token: 'theirs' });

		const stale = join(dir, 'stale.json');
		writeFileSync(stale, JSON.stringify({ ...other, pid: deadPid() }));
		const rt2 = await startRuntimeFile(stale, base);
		expect(read(stale)).toMatchObject({ state: 'starting', pid: process.pid });
		await rt2.remove();
	});

	it('an engine that fails to listen removes its starting record', async () => {
		const blocker = createServer();
		await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
		const port = (blocker.address() as { port: number }).port;
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-engine-'));
		try {
			await expect(startEngine({ appdir, port, dev: false, token: 'tok', env: {} })).rejects.toThrow(
				/EADDRINUSE/,
			);
			expect(existsSync(join(appdir, 'engine', 'runtime.json'))).toBe(false);
		} finally {
			blocker.close();
		}
	});
});
