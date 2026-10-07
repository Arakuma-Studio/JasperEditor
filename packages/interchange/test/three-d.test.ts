// three-d: 3D layers, cameras and lights on export — 3D layers are pre-rendered (they need the 3D renderer), and
// without a pre-render their 3D placement is reported; cameras and lights are reported as not carried.
import { describe, expect, it } from 'vitest';
import { exportTimeline, planPrerender } from '../src/index.ts';
import { Harness } from './support/rich.ts';

function scene() {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 0, 1, 1], ref: '$b' },
		{ type: 'clip.set3d', clipIds: ['$b'], enabled: true },
		{ type: 'clip.addCamera', at: 0, track: 'V3' },
	]);
	const ids = r.results.map((x) => (x as { clipId?: string }).clipId);
	return { h, a: ids[0]!, b: ids[1]!, cam: ids[3]! };
}

describe('3D on export', () => {
	it('pre-renders 3D layers for every format with video', () => {
		const { h, a, b } = scene();
		const jobs = planPrerender(h.doc, h.seqId, 'fcp7', 'unsupported');
		expect(jobs.find((j) => j.clipId === b)?.reason).toBe('3D layer');
		expect(jobs.some((j) => j.clipId === a)).toBe(false);
	});

	it('reports the 3D placement and the camera when nothing is pre-rendered', () => {
		const { h, b, cam } = scene();
		const out = exportTimeline(h.doc, h.seqId, 'fcp7');
		const text = JSON.stringify(out.report.entries);
		expect(text).toContain('3D placement');
		expect(out.report.entries.some((e) => e.subject?.id === b)).toBe(true);
		expect(out.report.entries.some((e) => e.subject?.id === cam && e.message.includes('camera'))).toBe(true);
	});
});
