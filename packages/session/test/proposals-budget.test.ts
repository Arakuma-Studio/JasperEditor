// Regression budget of the review preview's work (WP6.5b item 15), robust to the machine's load: it counts
// operations (transactions applied, items they carried, batches applied again one by one, invariant checks; the
// `previewStats` counters) and compares CPU time (`process.cpuUsage`) with the one-transaction-per-item reference
// measured in the same process, never wall time. 120 place items as the WP3.2 plan builds them (≈ 266 items).
import { createSeededIdSource, type ProposalItem, previewProposal, previewStats } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { proposalsFor } from '../src/index.ts';
import { bigProposal, bigSession } from './big-proposal.ts';

const N = 120;

describe(`review preview work budget (${N} place items)`, { timeout: 600_000 }, () => {
	it('the session builds the preview in batches: few transactions, each item applied once, one invariant check', async () => {
		const { session, engine } = bigSession(N);
		const p = bigProposal(session, engine, N);
		const queue: (() => void)[] = [];
		// a clock that says every batch took 1 ms: the batch size grows from 4 to 32 deterministically
		let now = 0;
		const c = proposalsFor(session, {
			engine,
			setTimer: (fn) => {
				queue.push(fn);
				return queue.length;
			},
			clearTimer: () => {},
			clock: () => (now += 0.5),
		});
		await c.setActive(p.id);
		previewStats(true);
		while (queue.length) queue.shift()!();
		const work = previewStats();
		const items = p.items.length;
		expect(c.getState().preview?.heard).toHaveLength(items);
		// before: one transaction per item (≈ 266) and no check; now ≈ items / 32 + the first small batches
		// the setup items (a bin, then the sounds imported into it, which changes the bin) are applied again one by one:
		// the first small batches (4 + 8 + 16 items), nothing after them
		expect(work.fallbacks).toBeLessThanOrEqual(3);
		expect(work.items).toBeLessThanOrEqual(items + 28);
		expect(work.transactions).toBeLessThanOrEqual(Math.ceil(items / 32) + 4 + 32);
		expect(work.transactions).toBeLessThan(items / 4);
		expect(work.checks).toBe(1);
		c.dispose();
	});

	it('costs at most half the CPU time of one transaction per item (same process, interleaved, best of 3)', () => {
		const { session, engine } = bigSession(N);
		const p = bigProposal(session, engine, N);
		const doc = session.getCommitted();
		const ctx = {
			registries: session.ctx.registries,
			revision: session.revision,
			now: () => '2026-10-16T10:00:00.000Z',
			invariants: 'incremental' as const,
		};
		const idsFor = (it: ProposalItem) =>
			createSeededIdSource(`${p.id}:${it.id}:${it.selectedAlternative ?? 0}`);
		const cpu = (batch: number) => {
			const t = process.cpuUsage();
			const r = previewProposal(doc, p, 'undecided', ctx, { idsFor, batch });
			const d = process.cpuUsage(t);
			expect(r.applied).toHaveLength(p.items.length);
			return (d.user + d.system) / 1000;
		};
		cpu(32); // warm up both paths
		cpu(1);
		const ref: number[] = [];
		const got: number[] = [];
		for (let i = 0; i < 3; i++) {
			ref.push(cpu(1));
			got.push(cpu(32));
		}
		const best = (xs: number[]) => Math.min(...xs);
		expect(best(got)).toBeLessThan(best(ref) * 0.5);
	});
});
