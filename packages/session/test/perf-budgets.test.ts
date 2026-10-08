// ARCHITECTURE §13 budgets, enforced (workstream `previews`, docs/performance.md): a single command on a 1 000-clip
// sequence < 4 ms, a 50-clip gesture update < 8 ms. Times are the best of several runs (median noise is the host's,
// not the code's) and the budgets scale with the measured host load unless PERF=1 (scripts/perf/budget.ts).
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport } from '../../../scripts/perf/budget.ts';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

async function bigSession(clips: number) {
	const ids = createCounterIdSource(1);
	const store = new MemoryProjectStore({ ids, now: () => '2026-09-30T10:00:00.000Z' });
	const doc = createEmptyProject({ ids, name: 'Perf', preset: 'hd-1080p-30' });
	store.put(doc);
	const ctx = { ids, now: () => '2026-09-30T10:00:00.000Z', registries: defaultRegistries() };
	const s = await EditorSession.open({ store, projectId: doc.projectId, ctx, sessionId: 'perf' });
	const commands = Array.from({ length: clips }, (_, i) => ({
		type: 'clip.addSolid' as const,
		at: Math.floor(i / 4) * 40,
		duration: 30,
		track: `V${(i % 4) + 1}`,
		color: [1, 0, 0, 1] as [number, number, number, number],
	}));
	commands.push(...[]);
	const r = s.apply({
		label: 'setup',
		origin: 'user',
		commands: [{ type: 'track.add', kind: 'video', count: 1 }, ...commands],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return s;
}

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
		});
		console.info(budgetReport('command on 1 000 clips', ms, 4));
		expect(ms).toBeLessThan(budgetMs(4));
	}, 120_000);

	it('a 50-clip gesture update < 8 ms', async () => {
		const s = await bigSession(1000);
		const ids = clipIdsOf(s.getCommitted()).slice(0, 50);
		const g = s.beginGesture('Move');
		let d = 0;
		const ms = best(15, () => {
			const r = g.update([{ type: 'clip.move', clipIds: ids, deltaFrames: 1000 + ++d }]);
			if (!r.ok) throw new Error(JSON.stringify(r.errors));
		});
		g.cancel();
		console.info(budgetReport('50-clip gesture update', ms, 8));
		expect(ms).toBeLessThan(budgetMs(8));
	}, 120_000);
});
