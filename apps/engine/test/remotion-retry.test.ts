// A multi-page Remotion render that times out is rendered once more on one page before failing (verify workstream:
// six pages mounting a heavy composition on a loaded, software-GL machine timed out where one page renders it).
import { describe, expect, it } from 'vitest';
import { withSinglePageRetry } from '../src/remotion/service.ts';

const timeout = () => new Error('A delayRender() "Retimed layer x" was called but not cleared after 58000ms');

describe('withSinglePageRetry', () => {
	it('a timeout on several pages is retried once on one page, and logged', async () => {
		const pages: number[] = [];
		const lines: string[] = [];
		await withSinglePageRetry(
			6,
			new AbortController().signal,
			(l) => lines.push(l),
			async (c) => {
				pages.push(c);
				if (c > 1) throw timeout();
			},
		);
		expect(pages).toEqual([6, 1]);
		expect(lines[0]).toMatch(/rendering again on one page \(was 6\)/);
	});

	it('a second timeout fails with the typed error', async () => {
		const pages: number[] = [];
		const err = await withSinglePageRetry(4, new AbortController().signal, undefined, async (c) => {
			pages.push(c);
			throw timeout();
		}).catch((e) => e);
		expect(pages).toEqual([4, 1]);
		expect(err).toMatchObject({ code: 'RENDER_TIMEOUT' });
	});

	it('no retry for other errors, a single page or a cancelled render', async () => {
		const run = async (concurrency: number, error: Error, signal = new AbortController().signal) => {
			const pages: number[] = [];
			const e = await withSinglePageRetry(concurrency, signal, undefined, async (c) => {
				pages.push(c);
				throw error;
			}).catch((x) => x);
			return { pages, e };
		};
		expect((await run(6, new Error('boom'))).pages).toEqual([6]);
		expect((await run(1, timeout())).pages).toEqual([1]);
		const ac = new AbortController();
		ac.abort();
		const cancelled = await run(6, timeout(), ac.signal);
		expect(cancelled.pages).toEqual([6]);
		expect(cancelled.e).toMatchObject({ code: 'JOB_CANCELLED' });
	});
});
