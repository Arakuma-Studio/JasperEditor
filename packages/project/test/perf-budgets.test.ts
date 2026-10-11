// Budgets scale with measured host load unless PERF=1 (scripts/perf/budget.ts; docs/performance.md).
import { describe, expect, it } from 'vitest';
import { budgetMs, budgetReport } from '../../../scripts/perf/budget.ts';
import {
	buildRenderSnapshot,
	flicksPerFrame,
	type MediaHandle,
	previewSegments,
	resolveSceneAt,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F30 = flicksPerFrame({ num: 30, den: 1 });
const handle: MediaHandle = {
	url: 'x',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: 60 * 705_600_000,
	hasAudio: true,
	rotation: 0,
};
const best = (n: number, fn: () => void) => {
	let b = Number.POSITIVE_INFINITY;
	for (let i = 0; i < n; i++) {
		const t0 = performance.now();
		fn();
		b = Math.min(b, performance.now() - t0);
	}
	return b;
};

describe('model budgets', () => {
	it('resolveSceneAt with 50 layers < 1 ms', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 60 });
		h.ok([{ type: 'track.add', kind: 'video', count: 47 }]);
		const cmds = Array.from({ length: 50 }, (_, i) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			tracks: { video: `V${i + 1}` },
			video: true,
			audio: false,
			sourceRange: { in: { flicks: 0 }, out: { flicks: 60 * F30 } },
		}));
		h.ok(cmds);
		h.ok(
			h
				.clips()
				.map((c, i) => ({ type: 'param.set', target: ['clip', c.id, 'transform', 'rotation'], value: i })),
		);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => handle, resolveFont: () => null });
		expect(resolveSceneAt(snap, 10)).toHaveLength(50);
		let f = 0;
		const ms = best(30, () => void resolveSceneAt(snap, f++ % 60));
		console.info(budgetReport('resolveSceneAt, 50 layers', ms, 1));
		expect(ms).toBeLessThan(budgetMs(1));
	});

	it('render bar of a 1 000-clip sequence < 120 ms', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 60 });
		h.ok(
			Array.from({ length: 500 }, (_, i) => ({
				type: 'clip.place',
				source: { mediaId: m },
				at: i * 40,
				tracks: { video: i % 2 ? 'V2' : 'V1' },
				sourceRange: { in: { flicks: 0 }, out: { flicks: 60 * F30 } },
			})),
		);
		const ms = best(4, () => {
			const segs = previewSegments(structuredClone(h.doc), h.seqId);
			if (segs.length < 900) throw new Error(`${segs.length} segments`);
		});
		console.info(budgetReport('render bar, 1 000 clips', ms, 120));
		expect(ms).toBeLessThan(budgetMs(120));
	}, 60_000);
});
