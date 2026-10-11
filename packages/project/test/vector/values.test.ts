import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	bezierPathToBez,
	bezToBezierPaths,
	type GradientValue,
	gradientSvgStops,
	lerpGradientValue,
	midpointCurve,
	sampleGradient,
	shapeGeom,
} from '../../src/index.ts';
import { dashIntervals, widthFactor } from '../../src/vector/varstroke.ts';

const g: GradientValue = {
	colors: [
		{ position: 0, color: [1, 0, 0], midpoint: 0.25 },
		{ position: 1, color: [0, 0, 1] },
	],
	opacities: [
		{ position: 0, opacity: 1 },
		{ position: 0.5, opacity: 0 },
		{ position: 1, opacity: 1 },
	],
};

describe('gradients', () => {
	it('midpoints put the 50 % blend at the midpoint; opacity stops are independent', () => {
		expect(midpointCurve(0.25, 0.25)).toBeCloseTo(0.5, 12);
		expect(sampleGradient(g, 0.25)[0]).toBeCloseTo(0.5, 9);
		expect(sampleGradient(g, 0.5)[3]).toBe(0);
		expect(sampleGradient(g, 0.75)[3]).toBeCloseTo(0.5, 9);
	});
	it('SVG stops reproduce the gradient with linear interpolation', () => {
		const stops = gradientSvgStops(g);
		expect(stops.length).toBeGreaterThan(10);
		for (const t of [0.1, 0.3, 0.6, 0.9]) {
			const i = stops.findIndex((s) => s.offset >= t);
			const a = stops[i - 1]!;
			const b = stops[i]!;
			const u = (t - a.offset) / (b.offset - a.offset);
			const r = a.color[0] + (b.color[0] - a.color[0]) * u;
			expect(r).toBeCloseTo(sampleGradient(g, t)[0], 2);
		}
	});
	it('interpolates keys with different stop structures through resampling', () => {
		const b: GradientValue = { colors: [{ position: 0, color: [0, 1, 0] }], opacities: [] };
		const m = lerpGradientValue(g, b, 0.5);
		expect(sampleGradient(m, 0)[1]).toBeCloseTo(0.5, 6);
		expect(lerpGradientValue(g, b, 0)).toBeTruthy();
	});
});

describe('path values', () => {
	it('round-trips compound paths and keeps closed curves', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 })), {
					minLength: 2,
					maxLength: 12,
				}),
				fc.boolean(),
				(pts, closed) => {
					const v = {
						closed,
						vertices: pts.map((p, i) => ({
							p: p as [number, number],
							in: i % 2 ? ([3, 4] as [number, number]) : ([0, 0] as [number, number]),
							out: [0, 0] as [number, number],
						})),
					};
					const back = bezToBezierPaths(bezierPathToBez(v));
					const again = bezierPathToBez(back[0]!);
					expect(shapeGeom.toSvgPath(again)).toBe(shapeGeom.toSvgPath(bezierPathToBez(v)));
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe('variable strokes', () => {
	it('taper and wave width profiles (EffectCraft cases)', () => {
		const t = {
			percent: false,
			startLength: 50,
			endLength: 0,
			startWidth: 0,
			endWidth: 1,
			startEase: 0,
			endEase: 0,
		};
		expect(widthFactor(t, null, 0, 200)).toBeCloseTo(0, 9);
		expect(widthFactor(t, null, 25, 200)).toBeCloseTo(0.5, 9);
		expect(widthFactor({ ...t, startEase: 1 }, null, 25, 200)).toBeGreaterThan(0.8);
		const w = { amount: 1, cycles: null, wavelength: 40, phase: 0 };
		expect(widthFactor(null, w, 20, 200)).toBeCloseTo(0, 9);
		expect(widthFactor(null, { ...w, cycles: 5 }, 20, 200)).toBeCloseTo(0, 9);
	});
	it('dash intervals with several pairs and an offset', () => {
		expect(dashIntervals([10, 5, 2, 3], 0, 45)).toEqual([
			[0, 10],
			[15, 17],
			[20, 30],
			[35, 37],
			[40, 45],
		]);
		expect(dashIntervals([10, 10], 5, 30)).toEqual([
			[0, 5],
			[15, 25],
		]);
	});
});
