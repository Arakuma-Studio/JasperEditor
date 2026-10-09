// Worker pools of the native export (blend, layer streams, warp, optical flow): a worker that dies while idle must
// fail the pool, never stay in the idle list. Regression (verify workstream): the dev engine (tsx) evaluated worker
// sources that contained esbuild's `__name()` helper, every blend worker died at start-up with nothing pending, the
// next frame was posted to a dead worker and a `render_frame` with a GL blend mode hung "running" forever.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { BlendPool } from '../src/export/blend/pool.ts';
import { FlowPool } from '../src/export/retime/pool.ts';
import { LayerPool } from '../src/export/stream/pool.ts';
import { WarpPool } from '../src/export/warp/pool.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Settles `p` or fails after `ms` (a hang is the bug). */
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
		if ((e as Error).message.startsWith('HANG')) throw e;
		return { ok: false, error: e as Error };
	} finally {
		clearTimeout(timer);
	}
}

async function killIdleWorker(pool: unknown): Promise<void> {
	const w = (pool as { workers: Worker[] }).workers[0]!;
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
		const r = await settles(pool.run({} as never));
		expect(r.ok).toBe(false);
		await pool.close();
	});

	it('warp: fails once the worker died', async () => {
		const pool = new WarpPool(
			{ sw: 2, sh: 2, dw: 2, dh: 2, format: 'rgba' as never },
			{ workers: 1, slots: 1 },
		);
		await killIdleWorker(pool);
		const r = await settles(pool.run({} as never));
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
