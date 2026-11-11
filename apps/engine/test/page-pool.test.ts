import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { JobError } from '../src/jobs/types.ts';
import { type PageGrant, type PagePoolProgress, pageShares, runPagePool } from '../src/remotion/page-pool.ts';

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

describe('page budget', () => {
	it('never grants more pages than the render budget', async () => {
		const big = manual(4);
		const mid = manual(3);
		const s1 = manual(1, 1);
		const s2 = manual(1, 1);
		const tasks = [s1, mid, big, s2];
		const p = runPagePool(tasks, { budget: 6, maxInFlight: 4, signal: new AbortController().signal });
		await setImmediate();
		expect([big, mid, s1, s2].reduce((n, t) => n + (t.grant?.pages ?? 0), 0)).toBeLessThanOrEqual(6);
		mid.finish();
		await setImmediate();
		expect([big, s1, s2].reduce((n, t) => n + (t.grant?.pages ?? 0), 0)).toBeLessThanOrEqual(6);
		big.finish();
		s1.finish('a');
		s2.finish('b');
		expect(await p).toEqual(['a', 'ok', 'ok', 'b']);
	});

	it('bounds the renders in flight; maxInFlight 1 runs them one after the other with the whole budget', async () => {
		const ts = [manual(1, 1), manual(1, 1), manual(1, 1), manual(1, 1), manual(1, 1), manual(1, 1)];
		const p = runPagePool(ts, { budget: 6, maxInFlight: 4, signal: new AbortController().signal });
		await setImmediate();
		expect(ts.filter((t) => t.started)).toHaveLength(4);
		for (const t of ts) if (t.started) t.finish();
		await setImmediate();
		expect(ts.every((t) => t.started)).toBe(true);
		for (const t of ts) t.finish();
		await p;
		const seq = [manual(6), manual(2)];
		const q = runPagePool(seq, { budget: 6, maxInFlight: 1, signal: new AbortController().signal });
		await setImmediate();
		expect(seq[0]!.grant?.pages).toBe(6);
		expect(seq[1]!.started).toBe(false);
		seq[0]!.finish();
		await setImmediate();
		expect(seq[1]!.grant?.pages).toBe(2);
		seq[1]!.finish();
		await q;
	});

	it('more masters than renders in flight share the whole budget among those running at once', async () => {
		// the real project's bake: 17 text cards of 363 frames, 12 pages, at most 6 renders at once
		const shares = pageShares(new Array(17).fill(363), 12, 6);
		expect(shares).toEqual(new Array(17).fill(2));
		const ts = shares.map((want) => manual(want));
		const p = runPagePool(ts, { budget: 12, maxInFlight: 6, signal: new AbortController().signal });
		await setImmediate();
		expect(ts.reduce((n, t) => n + (t.grant?.pages ?? 0), 0)).toBe(12);
		for (const t of ts) if (t.started) t.finish();
		await setImmediate();
		for (const t of ts) if (t.started) t.finish();
		await setImmediate();
		for (const t of ts) t.finish();
		await p;
		// as many masters as may run at once: the plain proportional split
		expect(pageShares([300, 100], 8, 6)).toEqual(pageShares([300, 100], 8));
	});

	it('a short master renders on few pages: each page costs a bundle load and its window (export-performance §13)', () => {
		// the 2 s title of the report: 60 frames with a 16-page budget rendered on 6 pages
		expect(pageShares([60, 180], 16)).toEqual([2, 6]);
	});

	it('a render that captured its frames gives its pages to the next render while it finishes', async () => {
		const a = manual(4);
		const b = manual(4);
		const c = manual(4);
		const p = runPagePool([a, b, c], { budget: 4, maxInFlight: 1, signal: new AbortController().signal });
		await setImmediate();
		expect([a.started, b.started]).toEqual([true, false]);
		// a is stitched and checked: b renders on its pages (and no longer waits for a's render slot)
		a.grant!.release();
		a.grant!.release();
		await setImmediate();
		expect(b.grant?.pages).toBe(4);
		expect(c.started).toBe(false);
		a.finish();
		await setImmediate();
		expect(c.started).toBe(false);
		b.finish();
		await setImmediate();
		expect(c.grant?.pages).toBe(4);
		c.finish();
		await p;
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
		await setImmediate();
		a.grant!.progress(0.5);
		expect(seen.at(-1)).toMatchObject({ done: 0, running: 2, total: 2 });
		expect(seen.at(-1)!.fraction).toBeCloseTo(15 / 40);
		b.finish();
		await setImmediate();
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
		await setImmediate();
		expect(a.started && b.started).toBe(true);
		a.fail(new JobError('RENDER_FAILED', 'boom'));
		await setImmediate();
		expect(b.aborted).toBe(true);
		expect(c.started).toBe(false);
		const err = (await settled) as JobError;
		expect(err.code).toBe('RENDER_FAILED');
	});

	it('aborting the signal cancels every render in flight and rejects with JOB_CANCELLED', async () => {
		const ac = new AbortController();
		const ts = [manual(1, 1), manual(1, 1), manual(1, 1)];
		const p = runPagePool(ts, { budget: 2, signal: ac.signal });
		const settled = p.then(
			() => null,
			(e) => e,
		);
		await setImmediate();
		ac.abort();
		await setImmediate();
		expect(ts.filter((t) => t.aborted)).toHaveLength(2);
		expect(ts[2]!.started).toBe(false);
		const err = (await settled) as JobError;
		expect(err.code).toBe('JOB_CANCELLED');
		const waiting = manual(1);
		const cancelled = runPagePool([waiting], { budget: 2, signal: ac.signal });
		expect(waiting.started).toBe(false);
		await expect(cancelled).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
		expect(await runPagePool([], { budget: 2, signal: new AbortController().signal })).toEqual([]);
	});
});
