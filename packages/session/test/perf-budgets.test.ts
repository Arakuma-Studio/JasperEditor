// ARCHITECTURE §13 budgets (workstream `previews`, met by `perf-core`; docs/performance.md): a single command on a
// 1 000-clip sequence, with the per-track reindex the timeline then does, < 4 ms; a 50-clip gesture update (with
// the reindex) < 8 ms. Times are the best of several runs (median noise is the host's, not the code's). PERF=1
// enforces the budgets exactly; the normal gate scales them by the host's measured load (scripts/perf/budget.ts)
// with 1.5× headroom, so a loaded shared machine does not fail them while a real regression still does.
import {
	clipsOnTrack,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport, PERF_STRICT } from '../../../scripts/perf/budget.ts';

/** The §13 budgets and the normal gate's headroom over them (× the load factor). */
const COMMAND_BUDGET_MS = 4;
const GESTURE_BUDGET_MS = 8;
const HEADROOM = 1.5;

import { EditorSession, MemoryProjectStore } from '../src/index.ts';

async function bigSession(clips: number) {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-09-30T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'Perf', preset: 'hd-1080p-30' });
	store.put(doc);
	// The production invariant mode (tests default to `verify`, which also runs the full check).
	const ctx = {
		ids,
		now: () => '2026-09-30T10:00:00.000Z',
		registries: defaultRegistries(),
		invariants: 'incremental' as const,
	};
	const s = await EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId: 'perf' });
	const commands = Array.from({ length: clips }, (_, i) => ({
		type: 'clip.addSolid' as const,
		at: Math.floor(i / 4) * 40,
		duration: 30,
		track: `V${(i % 4) + 1}`,
		color: [1, 0, 0, 1] as [number, number, number, number],
	}));
	const r = s.apply({
		label: 'setup',
		origin: 'user',
		commands: [{ type: 'track.add', kind: 'video', count: 1 }, ...commands],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return s;
}

/** The reindex the timeline does after a change: every track's sorted clip list of the drawn sequence. */
const reindex = (doc: ProjectDocument) => {
	const seq = Object.values(doc.sequences)[0]!;
	let n = 0;
	for (const t of [...seq.videoTracks, ...seq.audioTracks]) n += clipsOnTrack(seq, t.id).length;
	return n;
};
const clipIdsOf = (doc: ProjectDocument) =>
	Object.values(Object.values(doc.sequences)[0]!.clips).map((c) => c.id);
const best = (n: number, fn: () => void) => {
	let b = Number.POSITIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		fn();
		b = Math.min(b, performance.now() - t0);
	}
	return b;
};

describe('ARCHITECTURE §13 budgets', () => {
	it('one command on a 1 000-clip sequence (apply + reindex) < 4 ms', async () => {
		const s = await bigSession(1000);
		const ids = clipIdsOf(s.getCommitted());
		expect(ids.length).toBe(1000);
		let k = 0;
		const ms = best(15, () => {
			const id = ids[k++ % ids.length]!;
			const r = s.apply({
				label: 'Opacity',
				origin: 'user',
				commands: [{ type: 'param.set', target: ['clip', id, 'opacity'], value: 50 + (k % 40) }],
			});
			if (!r.ok) throw new Error(JSON.stringify(r.errors));
			reindex(s.getCommitted());
		});
		console.info(budgetReport('command on 1 000 clips', ms, COMMAND_BUDGET_MS));
		expect(ms).toBeLessThan(PERF_STRICT ? COMMAND_BUDGET_MS : budgetMs(COMMAND_BUDGET_MS * HEADROOM));
	}, 120_000);

	it('a 50-clip gesture update < 8 ms', async () => {
		const s = await bigSession(1000);
		const ids = clipIdsOf(s.getCommitted()).slice(0, 50);
		const g = s.beginGesture('Move');
		let d = 0;
		const ms = best(15, () => {
			const r = g.update([{ type: 'clip.move', clipIds: ids, deltaFrames: 1000 + ++d }]);
			if (!r.ok) throw new Error(JSON.stringify(r.errors));
			reindex(s.getDrawn());
		});
		g.cancel();
		console.info(budgetReport('50-clip gesture update', ms, GESTURE_BUDGET_MS));
		expect(ms).toBeLessThan(PERF_STRICT ? GESTURE_BUDGET_MS : budgetMs(GESTURE_BUDGET_MS * HEADROOM));
	}, 120_000);
});
