import type { ClipTracker, Quad } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import type { View } from '../src/panels/program/viewport.ts';
import { screenToMedia, trailAt } from '../src/tracking/geometry.ts';

const view: View = { scale: 0.5, x: 12, y: 30 };
const REF: Quad = [
	[700, 300],
	[1300, 320],
	[1280, 700],
	[690, 680],
];

describe('media px ↔ screen px', () => {
	it('returns null for a singular map', () => {
		expect(screenToMedia([0, 0, 0, 0, 0, 0, 0, 0, 1], view, [10, 10])).toBeNull();
	});
});

describe('confidence, trails and placement', () => {
	it('keeps the last 30 tracked centres up to the current time', () => {
		const step = 100;
		const data: number[] = [];
		for (let i = 0; i < 50; i++) for (const p of REF) data.push(p[0] + i, p[1]);
		const tracker = {
			kind: 'planar',
			reference: { time: 0, corners: REF },
			samples: { start: 0, step, stride: 8, data, confidence: new Array(50).fill(1) },
		} as unknown as ClipTracker;
		const trail = trailAt(tracker, 40 * step);
		expect(trail).toHaveLength(30);
		expect(trail[29]![0] - trail[0]![0]).toBeCloseTo(29, 6);
		expect(trailAt(tracker, -5 * step)).toHaveLength(0);
		expect(trailAt({ ...tracker, samples: null }, 0)).toEqual([]);
	});
});
