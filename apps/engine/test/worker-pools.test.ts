import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { BlendPool } from '../src/export/blend/pool.ts';
import { FlowPool } from '../src/export/retime/pool.ts';
import { LayerPool } from '../src/export/stream/pool.ts';
import { WarpPool } from '../src/export/warp/pool.ts';
import { ExportWorkerPool, framePoolSize } from '../src/export/worker-pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

async function settles<T>(
	p: Promise<T>,
	ms = 5000,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`HANG: not settled after ${ms} ms`)), ms);
	});
	try {
		return { ok: true, value: await Promise.race([p, timeout]) };
	} catch (e) {
		if (!(e instanceof Error) || e.message.startsWith('HANG')) throw e;
		return { ok: false, error: e };
	} finally {
		clearTimeout(timer);
	}
}

async function killIdleWorker(pool: BlendPool | LayerPool | WarpPool | FlowPool): Promise<void> {
	// biome-ignore-start lint/complexity/useLiteralKeys: Bracket access permits typed fault injection into private workers.
	// Narrow first: TypeScript cannot index distinct private members through a union.
	const scheduler =
		pool instanceof BlendPool
			? pool['pool']
			: pool instanceof LayerPool
				? pool['pool']
				: pool instanceof WarpPool
					? pool['pool']
					: pool['pool'];
	const w = scheduler['workers'][0]!;
	// biome-ignore-end lint/complexity/useLiteralKeys: Bracket access permits typed fault injection into private workers.
	const exited = once(w, 'exit');
	await w.terminate();
	await exited;
}

describe('native export worker pools survive a dead worker', () => {
	it('blend: blends a frame, then fails (does not hang) once its worker died', async () => {
		const pool = new BlendPool({ W: 2, H: 1 }, { workers: 1, slots: 1 });
		const slot = pool.slots[0]!;
		slot.src.set([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
		expect((await settles(pool.run(slot, 0, 0, true))).ok).toBe(true);
		await killIdleWorker(pool);
		const r = await settles(pool.run(slot, 0, 0, true));
		expect(r.ok).toBe(false);
		await pool.close();
	});

	it('layer streams: fail once the worker died', async () => {
		const pool = new LayerPool({ sw: 2, sh: 2, dw: 2, dh: 2 }, { workers: 1, slots: 1 });
		await killIdleWorker(pool);
		const r = await settles(
			pool.run({ slot: pool.slots[0]!, inv: null, rect: null, opacity: 1, cw: 2, ch: 2, clip: [0, 0, 2, 2] }),
		);
		expect(r.ok).toBe(false);
		await pool.close();
	});

	it('warp: fails once the worker died', async () => {
		const pool = new WarpPool({ sw: 2, sh: 2, dw: 2, dh: 2, format: 'rgba' }, { workers: 1, slots: 1 });
		await killIdleWorker(pool);
		const r = await settles(pool.run({ slot: pool.slots[0]!, inv: null, rect: null, opacity: 1 }));
		expect(r.ok).toBe(false);
		await pool.close();
	});

	it('optical flow: fails once the worker died', async () => {
		const pool = new FlowPool(1);
		await killIdleWorker(pool);
		const px = new Uint8Array(4 * 4 * 4);
		const r = await settles(pool.run('k', px, px, 4, 4, [0.5]));
		expect(r.ok).toBe(false);
		await pool.close();
	});

	it('optical flow: closing settles both running and queued requests', async () => {
		const pool = new FlowPool(1);
		const px = new Uint8Array(4 * 4 * 4);
		const requests = [
			settles(pool.run('first', px, px, 4, 4, [0.5])),
			settles(pool.run('queued', px, px, 4, 4, [0.5])),
		];
		await pool.close();
		for (const result of await Promise.all(requests)) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toBe('flow pool closed');
		}
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
					'const t = setTimeout(() => { console.log("hang"); process.exit(2); }, 10000);',
					'await pool.run(pool.slots[0]!, 0, 0, true);',
					'clearTimeout(t);',
					'await pool.close();',
					'console.log("ok");',
				].join('\n'),
			);
			const tsx = createRequire(import.meta.url).resolve('tsx/cli');
			const out = await new Promise<string>((resolve, reject) =>
				execFile(process.execPath, [tsx, script], { timeout: 60_000 }, (e, stdout, stderr) =>
					e ? reject(new Error(`${e.message}\n${stdout}\n${stderr}`)) : resolve(stdout),
				),
			);
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
			expect(() => new ExportWorkerPool('test', count, createWorker)).toThrow(/positive safe integer/);
			expect(createWorker).not.toHaveBeenCalled();
		},
	);

	it('bounds worker and frame-slot allocation', () => {
		const workers = availableParallelism();
		expect(framePoolSize({ workers: Number.MAX_SAFE_INTEGER, slots: Number.MAX_SAFE_INTEGER })).toEqual({
			workers,
			slots: workers + 3,
		});
		for (const slots of [Number.NaN, Infinity, 0, -1, 1.5])
			expect(() => framePoolSize({ workers: 1, slots })).toThrow(/frame slot count/);
	});

	it.skipIf(availableParallelism() < 2)('terminates already-created workers if startup fails', async () => {
		const worker = new Worker(`require('node:worker_threads').parentPort.on('message', () => {});`, {
			eval: true,
		});
		const exited = once(worker, 'exit');
		const error = new Error('worker resources exhausted');
		const createWorker = vi
			.fn<() => Worker>()
			.mockReturnValueOnce(worker)
			.mockImplementationOnce(() => {
				throw error;
			});
		expect(() => new ExportWorkerPool('test', 2, createWorker)).toThrow(error);
		expect((await settles(exited)).ok).toBe(true);
	});

	it('rejects running and queued tasks when a worker exits', async () => {
		const worker = new Worker(`require('node:worker_threads').parentPort.on('message', () => {});`, {
			eval: true,
		});
		const pool = new ExportWorkerPool<number, number>('test', 1, () => worker);
		const running = settles(pool.run(1));
		const queued = settles(pool.run(2));
		try {
			await worker.terminate();
			for (const result of await Promise.all([running, queued])) {
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.message).toMatch(/test worker exited/);
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
			expect((await settles(pool.run(() => 1))).ok).toBe(false);
		} finally {
			await pool.close();
		}
	});
});
