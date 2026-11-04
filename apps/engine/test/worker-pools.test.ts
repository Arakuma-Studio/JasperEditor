import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExportWorkerPool } from '../src/export/worker-pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

function outcomeOf<T>(p: Promise<T>): () => { ok: true; value: T } | { ok: false; error: Error } | undefined {
	let result: { ok: true; value: T } | { ok: false; error: Error } | undefined;
	void p.then(
		(value) => {
			result = { ok: true, value };
		},
		(error: Error) => {
			result = { ok: false, error };
		},
	);
	return () => result;
}

describe('native export worker pools survive a dead worker', () => {
	it('closing settles both running and queued requests', async () => {
		const pool = new ExportWorkerPool<number, number>(
			'test',
			1,
			() => new Worker(`require('node:worker_threads').parentPort.on('message', () => {});`, { eval: true }),
		);
		const requests = [outcomeOf(pool.run(1)), outcomeOf(pool.run(2))];
		await pool.close();
		for (const result of requests) expect(result()).toMatchObject({ ok: false, error: expect.any(Error) });
	});

	it('the blend pool works in the dev engine (tsx, esbuild keepNames)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-pool-'));
		try {
			const script = join(dir, 'run.mts');
			writeFileSync(
				script,
				[
					`import { BlendPool } from ${JSON.stringify(join(here, '../src/export/blend/pool.ts'))};`,
					'const pool = new BlendPool({ W: 2, H: 1 }, { workers: 1, slots: 1 });',
					'await pool.run(pool.slots[0]!, 0, 0, true);',
					'await pool.close();',
					'console.log("ok");',
				].join('\n'),
			);
			const tsx = createRequire(import.meta.url).resolve('tsx/cli');
			const out = await new Promise<string>((resolve, reject) => {
				const child = execFile(process.execPath, [tsx, script], (e, stdout, stderr) =>
					e ? reject(new Error(`${e.message}\n${stdout}\n${stderr}`)) : resolve(stdout),
				);
				onTestFinished(async () => {
					if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
					const exited = once(child, 'exit');
					child.kill('SIGKILL');
					await exited;
				});
			});
			expect(out.trim()).toBe('ok');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);
});

describe('export worker scheduling', () => {
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5])(
		'refuses invalid worker counts before allocating workers: %s',
		(count) => {
			const createWorker = vi.fn<() => Worker>();
			expect(() => new ExportWorkerPool('test', count, createWorker)).toThrow(RangeError);
			expect(createWorker).not.toHaveBeenCalled();
		},
	);

	it.skipIf(availableParallelism() < 2)('terminates already-created workers if startup fails', async () => {
		const worker = new Worker(
			`const { parentPort } = require('node:worker_threads');
parentPort.on('message', () => parentPort.postMessage('alive'));`,
			{ eval: true },
		);
		const exited = once(worker, 'exit').then(() => 'exited');
		const alive = once(worker, 'message').then(() => 'alive');
		const error = new Error('worker resources exhausted');
		const createWorker = vi
			.fn<() => Worker>()
			.mockReturnValueOnce(worker)
			.mockImplementationOnce(() => {
				throw error;
			});
		try {
			expect(() => new ExportWorkerPool('test', 2, createWorker)).toThrow(error);
			worker.postMessage(null);
			expect(await Promise.race([exited, alive])).toBe('exited');
			expect(worker.threadId).toBe(-1);
		} finally {
			await worker.terminate();
		}
	});

	it('rejects running and queued tasks when a worker exits', async () => {
		const worker = new Worker(`require('node:worker_threads').parentPort.on('message', () => {});`, {
			eval: true,
		});
		const pool = new ExportWorkerPool<number, number>('test', 1, () => worker);
		const running = outcomeOf(pool.run(1));
		const queued = outcomeOf(pool.run(2));
		try {
			await worker.terminate();
			for (const result of [running, queued]) {
				expect(result()).toMatchObject({
					ok: false,
					error: { message: expect.stringMatching(/test worker exited/) },
				});
			}
		} finally {
			await pool.close();
		}
	});

	it('rejects unclonable messages without leaving a request pending', async () => {
		const pool = new ExportWorkerPool<() => number, number>(
			'test',
			1,
			() => new Worker(`require('node:worker_threads').parentPort.on('message', () => {});`, { eval: true }),
		);
		try {
			const result = outcomeOf(pool.run(() => 1));
			await Promise.resolve();
			expect(result()).toMatchObject({ ok: false, error: { name: 'DataCloneError' } });
		} finally {
			await pool.close();
		}
	});
});
