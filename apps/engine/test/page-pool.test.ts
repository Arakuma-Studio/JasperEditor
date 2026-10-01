// Page pool (S11:LBK-022 parallel bakes): budget split, bounded renders in flight, order, progress, failure and
// abort propagation. No renders: tasks are promises the test resolves.
import { describe, expect, it } from 'vitest';
import { JobError } from '../src/jobs/types.ts';
import {
	MIN_FRAMES_PER_PAGE,
	type PageGrant,
	type PagePoolProgress,
	pageShares,
	poolOrder,
	runPagePool,
} from '../src/remotion/page-pool.ts';

/** A task the test finishes by hand; records its grant and whether it saw an abort. */
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
	it('masters split the budget by length: at least 1 page, at most the budget and one page per 10 frames', () => {
		expect(pageShares([90, 60, 60, 45], 6)).toEqual([2, 1, 1, 1]);
		// A lone master takes the whole budget (as the sequential path did); a short one only what it can use.
		expect(pageShares([60], 6)).toEqual([6]);
		expect(pageShares([25], 6)).toEqual([3]);
		expect(pageShares([300, 30, 30], 6)).toEqual([5, 1, 1]);
		expect(pageShares([1, 1, 1], 0)).toEqual([1, 1, 1]);
		expect(MIN_FRAMES_PER_PAGE).toBe(10);
	});

	it('starts the largest first and backfills small renders; pages in flight never exceed the budget', async () => {
		const big = manual(4);
		const mid = manual(3);
		const s1 = manual(1, 1);
		const s2 = manual(1, 1);
		const tasks = [s1, mid, big, s2];
		expect(poolOrder(tasks)).toEqual([2, 1, 0, 3]);
		const p = runPagePool(tasks, { budget: 6, maxInFlight: 4, signal: new AbortController().signal });
		await tick();
		// big takes 4; mid wants 3 and starts with 2 (≥ half); no page left for the stills.
		expect(big.grant?.pages).toBe(4);
		expect(mid.grant?.pages).toBe(2);
		expect(s1.started || s2.started).toBe(false);
		mid.finish();
		await tick();
		expect(s1.grant?.pages).toBe(1);
		expect(s2.grant?.pages).toBe(1);
		big.finish();
		s1.finish('a');
		s2.finish('b');
		expect(await p).toEqual(['a', 'ok', 'ok', 'b']);
	});

	it('waits rather than starting a large render with less than half its pages, unless nothing else runs', async () => {
		const a = manual(5);
		const b = manual(4);
		const p = runPagePool([a, b], { budget: 6, signal: new AbortController().signal });
		await tick();
		expect(a.grant?.pages).toBe(5);
		expect(b.started).toBe(false); // 1 page free < 2
		a.finish();
		await tick();
		expect(b.grant?.pages).toBe(4);
		b.finish();
		await p;
		// Alone, a render takes what there is.
		const c = manual(4);
		const q = runPagePool([c], { budget: 2, signal: new AbortController().signal });
		await tick();
		expect(c.grant?.pages).toBe(2);
		c.finish();
		await q;
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
		// An aborted signal starts nothing; no tasks resolves at once.
		await expect(runPagePool([manual(1)], { budget: 2, signal: ac.signal })).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
		expect(await runPagePool([], { budget: 2, signal: new AbortController().signal })).toEqual([]);
	});
});
