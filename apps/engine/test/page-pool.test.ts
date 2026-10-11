import { describe, expect, it } from 'vitest';
import { JobError } from '../src/jobs/types.ts';
import { type PageGrant, type PagePoolProgress, runPagePool } from '../src/remotion/page-pool.ts';

function manual(want: number, weight = want * 30) {
	let resolve: (v: string) => void = () => {};
	let reject: (e: unknown) => void = () => {};
	const t = {
		want,
		weight,
		grant: null as PageGrant | null,
		aborted: false,
		started: false,
		finish: (v = 'ok') => resolve(v),
		fail: (e: unknown) => reject(e),
		run(g: PageGrant) {
			t.started = true;
			t.grant = g;
			return new Promise<string>((res, rej) => {
				resolve = res;
				reject = rej;
				g.signal.addEventListener('abort', () => {
					t.aborted = true;
					rej(new JobError('JOB_CANCELLED', 'Cancelled'));
				});
			});
		},
	};
	return t;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('page budget', () => {
	it('never grants more pages than the render budget', async () => {
		const big = manual(4);
		const mid = manual(3);
		const s1 = manual(1, 1);
		const s2 = manual(1, 1);
		const tasks = [s1, mid, big, s2];
		const p = runPagePool(tasks, { budget: 6, maxInFlight: 4, signal: new AbortController().signal });
		await tick();
		expect([big, mid, s1, s2].reduce((n, t) => n + (t.grant?.pages ?? 0), 0)).toBeLessThanOrEqual(6);
		mid.finish();
		await tick();
		expect([big, s1, s2].reduce((n, t) => n + (t.grant?.pages ?? 0), 0)).toBeLessThanOrEqual(6);
		big.finish();
		s1.finish('a');
		s2.finish('b');
		expect(await p).toEqual(['a', 'ok', 'ok', 'b']);
	});

	it('bounds the renders in flight; maxInFlight 1 runs them one after the other with the whole budget', async () => {
		const ts = [manual(1, 1), manual(1, 1), manual(1, 1), manual(1, 1), manual(1, 1), manual(1, 1)];
		const p = runPagePool(ts, { budget: 6, maxInFlight: 4, signal: new AbortController().signal });
		await tick();
		expect(ts.filter((t) => t.started)).toHaveLength(4);
		for (const t of ts) if (t.started) t.finish();
		await tick();
		expect(ts.every((t) => t.started)).toBe(true);
		for (const t of ts) t.finish();
		await p;
		const seq = [manual(6), manual(2)];
		const q = runPagePool(seq, { budget: 6, maxInFlight: 1, signal: new AbortController().signal });
		await tick();
		expect(seq[0]!.grant?.pages).toBe(6);
		expect(seq[1]!.started).toBe(false);
		seq[0]!.finish();
		await tick();
		expect(seq[1]!.grant?.pages).toBe(2);
		seq[1]!.finish();
		await q;
	});

	it('aggregates progress by weight and counts finished renders', async () => {
		const a = manual(1, 30);
		const b = manual(1, 10);
		const seen: PagePoolProgress[] = [];
		const p = runPagePool([a, b], {
			budget: 2,
			signal: new AbortController().signal,
			onProgress: (s) => seen.push(s),
		});
		await tick();
		a.grant!.progress(0.5);
		expect(seen.at(-1)).toMatchObject({ done: 0, running: 2, total: 2 });
		expect(seen.at(-1)!.fraction).toBeCloseTo(15 / 40);
		b.finish();
		await tick();
		expect(seen.at(-1)).toMatchObject({ done: 1, running: 1 });
		expect(seen.at(-1)!.fraction).toBeCloseTo(25 / 40);
		a.finish();
		await p;
		expect(seen.at(-1)).toMatchObject({ done: 2, running: 0, fraction: 1 });
	});

	it('the first failure aborts the renders in flight, starts no more, and rejects once all have settled', async () => {
		const a = manual(2);
		const b = manual(2);
		const c = manual(2);
		const p = runPagePool([a, b, c], { budget: 4, signal: new AbortController().signal });
		const settled = p.then(
			() => null,
			(e) => e,
		);
		await tick();
		expect(a.started && b.started).toBe(true);
		a.fail(new JobError('RENDER_FAILED', 'boom'));
		const err = (await settled) as JobError;
		expect(err.code).toBe('RENDER_FAILED');
		expect(b.aborted).toBe(true);
		expect(c.started).toBe(false);
	});

	it('aborting the signal cancels every render in flight and rejects with JOB_CANCELLED', async () => {
		const ac = new AbortController();
		const ts = [manual(1, 1), manual(1, 1), manual(1, 1)];
		const p = runPagePool(ts, { budget: 2, signal: ac.signal });
		const settled = p.then(
			() => null,
			(e) => e,
		);
		await tick();
		ac.abort();
		const err = (await settled) as JobError;
		expect(err.code).toBe('JOB_CANCELLED');
		expect(ts.filter((t) => t.aborted)).toHaveLength(2);
		expect(ts[2]!.started).toBe(false);
		await expect(runPagePool([manual(1)], { budget: 2, signal: ac.signal })).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
		expect(await runPagePool([], { budget: 2, signal: new AbortController().signal })).toEqual([]);
	});
});
