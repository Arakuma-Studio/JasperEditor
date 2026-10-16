// The review preview of a large sound-design proposal (Phase 3 verification): N place items (+ their bin, 25 sounds
// and N new cues as setup items), as the WP3.2 plan builds them. A preview of more than 64 items is built in slices
// (the editor stays responsive), a local decision (accept / clear) rebuilds nothing, a reject rebuilds only what Hear
// plays, and the result equals the one-shot `previewProposal`. The gate runs N = 120; the measurement in the wp-note
// is `PROPOSALS_PERF_ITEMS=500 PROPOSALS_PERF_OUT=<file>` (timings written to the file).
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { proposalsFor } from '../src/index.ts';
import { bigProposal, bigSession } from './big-proposal.ts';

const N = Number(process.env.PROPOSALS_PERF_ITEMS ?? 120);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe(`review preview with ${N} place items`, { timeout: 600_000 }, () => {
	it('measures the recompute after a document change and after decisions', async () => {
		const { session, engine, seqId } = bigSession(N);
		const t0 = performance.now();
		const p = bigProposal(session, engine, N);
		const createMs = performance.now() - t0;
		// manual timers: a "run" drains them (the debounce, then every slice of the preview), timing the longest slice
		const queue: (() => void)[] = [];
		const c = proposalsFor(session, {
			engine,
			setTimer: (fn) => {
				queue.push(fn);
				return queue.length;
			},
			clearTimer: () => {},
		});
		const run = () => {
			const t = performance.now();
			let ran = 0;
			let longest = 0;
			const slices: number[] = [];
			while (queue.length && ran < 100_000) {
				const f = queue.shift()!;
				const t1 = performance.now();
				f();
				const d = performance.now() - t1;
				slices.push(d);
				longest = Math.max(longest, d);
				ran++;
			}
			// the five longest slices with their position (0 = the debounce's first slice)
			const top = slices
				.map((ms, i) => ({ i, ms: Math.round(ms) }))
				.sort((a, b) => b.ms - a.ms)
				.slice(0, 5);
			const sorted = [...slices].sort((a, b) => a - b);
			const pct = (q: number) =>
				Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
			return { ms: performance.now() - t, ran, longest, top, p50: pct(0.5), p95: pct(0.95) };
		};
		await c.setActive(p.id);
		const first = run();
		const preview = c.getState().preview!;
		expect(preview.heard.length).toBe(p.items.length);
		expect(first.ran).toBeGreaterThan(2); // the debounce, then several slices
		// the sliced build equals the one-shot preview (same seeded ids)
		const once = c.previewProposal(
			p.id,
			p.items.map((it) => it.id),
		)!;
		expect(Object.keys(once.document.sequences[seqId]!.clips).sort()).toEqual(
			Object.keys(preview.document.sequences[seqId]!.clips).sort(),
		);
		expect(preview.result.applied).toEqual(once.applied);
		// a document change elsewhere (a marker): the whole preview is rebuilt on the new document
		session.apply({
			label: 'Edit',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'marker.add', frame: 5, name: 'x' }] as never[],
		});
		const afterEdit = run();
		// a local accept (not applied yet): nothing to rebuild
		const place = p.items.filter((it) => it.id.startsWith('sfx:'));
		const beforeAccept = c.getState().preview;
		await c.setItemDecision([place[3]!.id], 'accept');
		const afterAccept = run();
		expect(afterAccept.ran).toBe(1); // the debounce only: no slice
		expect(c.getState().preview!.result).toBe(beforeAccept!.result);
		expect(c.getState().preview!.document).toBe(beforeAccept!.document);
		expect(c.getState().items.find((it) => it.id === place[3]!.id)?.state).toBe('accepted');
		// a reject (engine): the heard document leaves it out
		await c.setItemDecision([place[10]!.id], 'reject');
		await settle();
		const resultBeforeReject = c.getState().preview!.result;
		const afterReject = run();
		// the ghosts' preview (rejected items included) is reused; only what Hear plays was rebuilt
		expect(c.getState().preview!.result).toBe(resultBeforeReject);
		const items = c.getState().items.length;
		const ms = (r: ReturnType<typeof run>) => ({
			totalMs: Math.round(r.ms),
			slices: r.ran,
			longestSliceMs: Math.round(r.longest),
			p50SliceMs: r.p50,
			p95SliceMs: r.p95,
			top: r.top,
		});
		const report = JSON.stringify({
			items: p.items.length,
			reviewRows: place.length,
			createMs: Math.round(createMs),
			first: ms(first),
			afterEdit: ms(afterEdit),
			afterAccept: ms(afterAccept),
			afterReject: ms(afterReject),
			reviewItems: items,
		});
		if (process.env.PROPOSALS_PERF_OUT) writeFileSync(process.env.PROPOSALS_PERF_OUT, `${report}\n`);
		expect(c.getState().items.find((it) => it.id === place[10]!.id)?.state).toBe('rejected');
		expect(c.getState().preview?.heard).not.toContain(place[10]!.id);
		c.dispose();
	});
});
