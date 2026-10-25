// Crop in the effect stack (schema v8) and its Edge Feather profile (render/crop.ts, docs/wp-notes/crop-order.md):
// the profile laws every renderer relies on, the crop window with flips before / after the crop, and the pinned crop.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	cropCoverageAt,
	cropEdgeCoverage,
	cropFeather,
	cropInsets,
	cropMayFeather,
	cropWindow,
	intersectCropInsets,
	mirrorCropInsets,
	pinnedCropOf,
	resolveLayerProps,
	stackCrops,
} from '../src/index.ts';

const crop = (params: Record<string, unknown>, enabled = true) => ({
	effectId: 'jasper.crop',
	enabled,
	params,
});
const flipH = { effectId: 'jasper.flip-horizontal', enabled: true, params: {} };
const flipV = { effectId: 'jasper.flip-vertical', enabled: true, params: {} };
const mirror = { effectId: 'jasper.mirror', enabled: true, params: {} };

/** Numerical average of the ramp clamp(u / f, 0, 1) over the pixel [d − ½, d + ½] (midpoint rule). */
function rampAverage(d: number, f: number, steps = 4000): number {
	let s = 0;
	for (let i = 0; i < steps; i++) {
		const u = d - 0.5 + (i + 0.5) / steps;
		s += f === 0 ? (u > 0 ? 1 : 0) : Math.min(1, Math.max(0, u / f));
	}
	return s / steps;
}

describe('Edge Feather profile (cropEdgeCoverage)', () => {
	it('is the linear ramp averaged over the pixel (box filter), the hard edge’s area coverage at feather 0', () => {
		for (const f of [0, 0.3, 1, 2.5, 6, 40])
			for (const d of [-1, -0.5, -0.2, 0, 0.25, 0.5, 0.9, 1.7, 3, 7.5, 41])
				expect(cropEdgeCoverage(d, f)).toBeCloseTo(rampAverage(d, f), 3);
		// Hard edge: a pixel whose centre lies 0.25 px inside is 75 % covered.
		expect(cropEdgeCoverage(0.25, 0)).toBeCloseTo(0.75, 12);
		expect(cropEdgeCoverage(-0.5, 0)).toBe(0);
		expect(cropEdgeCoverage(0.5, 0)).toBe(1);
		// Feather 40: the pixel centred 20 px inside the edge is half transparent.
		expect(cropEdgeCoverage(20, 40)).toBeCloseTo(0.5, 12);
	});

	it('stays in [0, 1], is monotone in the distance, falls with the feather and is continuous at feather 0', () => {
		fc.assert(
			fc.property(
				fc.double({ min: -50, max: 1100, noNaN: true }),
				fc.double({ min: 0, max: 1000, noNaN: true }),
				fc.double({ min: 0, max: 5, noNaN: true }),
				(d, f, step) => {
					const c = cropEdgeCoverage(d, f);
					expect(c).toBeGreaterThanOrEqual(0);
					expect(c).toBeLessThanOrEqual(1);
					expect(cropEdgeCoverage(d + step, f)).toBeGreaterThanOrEqual(c - 1e-12);
					expect(cropEdgeCoverage(d, f + step)).toBeLessThanOrEqual(c + 1e-12);
					if (d <= -0.5) expect(c).toBe(0);
					if (d >= f + 0.5) expect(c).toBe(1);
				},
			),
		);
		fc.assert(
			fc.property(fc.double({ min: -3, max: 3, noNaN: true }), (d) => {
				expect(Math.abs(cropEdgeCoverage(d, 1e-9) - cropEdgeCoverage(d, 0))).toBeLessThan(1e-6);
			}),
		);
	});

	it('multiplies the four edges of the crop window (cropCoverageAt)', () => {
		const ins: [number, number, number, number] = [0.1, 0.2, 0.25, 0.05];
		const [w, h, f] = [400, 200, 12];
		for (const [x, y] of [
			[45.5, 60.5],
			[200.5, 100.5],
			[299.5, 189.5],
			[5.5, 5.5],
		] as const) {
			const want =
				cropEdgeCoverage(x - 40, f) *
				cropEdgeCoverage(300 - x, f) *
				cropEdgeCoverage(y - 40, f) *
				cropEdgeCoverage(190 - y, f);
			expect(cropCoverageAt(x, y, w, h, ins, f)).toBeCloseTo(want, 12);
		}
		// Inside, farther than the feather from every edge: untouched.
		expect(cropCoverageAt(200.5, 100.5, w, h, ins, f)).toBe(1);
		// Outside the window: nothing.
		expect(cropCoverageAt(10.5, 100.5, w, h, ins, f)).toBe(0);
	});
});

describe('crop params', () => {
	it('clamps insets to 0…100 % and the feather to 0…1000 px; nonfinite values are 0', () => {
		expect(cropInsets({ left: -5, top: 150, right: Number.NaN, bottom: 12.5 })).toEqual([0, 1, 0, 0.125]);
		expect(cropFeather({ feather: 5000 })).toBe(1000);
		expect(cropFeather({ feather: -3 })).toBe(0);
		expect(cropFeather({ feather: Number.POSITIVE_INFINITY })).toBe(0);
		expect(cropFeather({})).toBe(0);
	});

	it('cropMayFeather: an evaluated value, an Animatable value, a keyframe above 0 or an enabled expression', () => {
		expect(cropMayFeather({ feather: 0 })).toBe(false);
		expect(cropMayFeather({ feather: 3 })).toBe(true);
		expect(cropMayFeather({ feather: { value: 0, keyframes: [] } })).toBe(false);
		expect(cropMayFeather({ feather: { value: 0, keyframes: [{ value: 0 }, { value: 8 }] } })).toBe(true);
		expect(cropMayFeather({ feather: { value: 0, keyframes: [], expression: { enabled: true } } })).toBe(
			true,
		);
		expect(cropMayFeather({ feather: { value: 0, keyframes: [], expression: { enabled: false } } })).toBe(
			false,
		);
		expect(cropMayFeather({})).toBe(false);
	});
});

describe('the crop window in stack order', () => {
	const left30 = crop({ left: 30 });
	it('a flip after the crop mirrors its window; one before does not (it cuts the flipped picture)', () => {
		expect(cropWindow([left30, flipH])).toEqual({ left: 0, top: 0, right: 30, bottom: 0 });
		expect(cropWindow([flipH, left30])).toEqual({ left: 30, top: 0, right: 0, bottom: 0 });
		expect(cropWindow([crop({ top: 10 }), flipV, flipH])).toEqual({ left: 0, top: 0, right: 0, bottom: 10 });
		// Two flips of the same axis cancel; disabled flips do not count.
		expect(cropWindow([left30, flipH, flipH])).toEqual({ left: 30, top: 0, right: 0, bottom: 0 });
		expect(cropWindow([left30, { ...flipH, enabled: false }])).toEqual({
			left: 30,
			top: 0,
			right: 0,
			bottom: 0,
		});
	});

	it('intersects several crops, ignores disabled ones and returns null without a crop', () => {
		expect(cropWindow([crop({ left: 10, top: 5 }), mirror, crop({ left: 4, right: 20 })])).toEqual({
			left: 10,
			top: 5,
			right: 20,
			bottom: 0,
		});
		expect(cropWindow([crop({ left: 50 }, false), mirror])).toBeNull();
		expect(cropWindow([])).toBeNull();
		expect(intersectCropInsets([])).toBeNull();
		expect(mirrorCropInsets([0.1, 0.2, 0.3, 0.4], true, true)).toEqual([0.3, 0.4, 0.1, 0.2]);
	});

	it('stackCrops keeps stack indexes and feathers', () => {
		const list = stackCrops([mirror, crop({ left: 20, feather: 7 }), flipH]);
		expect(list.map((c) => [c.index, c.insets, c.feather])).toEqual([[1, [0, 0, 0.2, 0], 7]]);
	});

	it('resolveLayerProps reports the window of a crop placed after a flip, and its quad', () => {
		const anim = <T>(value: T) => ({ value, keyframes: [] });
		const fx = (id: string, effectId: string, params: Record<string, unknown> = {}) => ({
			id,
			effectId,
			effectVersion: 1,
			enabled: true,
			params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, anim(v)])),
		});
		const props = (effects: ReturnType<typeof fx>[]) =>
			resolveLayerProps(
				{
					transform: null,
					opacity: anim(100),
					intrinsicBox: { width: 100, height: 50 },
					effects,
				} as unknown as Parameters<typeof resolveLayerProps>[0],
				0,
			);
		const after = props([fx('a', 'jasper.crop', { left: 30 }), fx('b', 'jasper.flip-horizontal')]);
		expect(after.crop).toEqual({ left: 0, top: 0, right: 30, bottom: 0 });
		expect(after.bounds).toEqual({ x: 0, y: 0, width: 70, height: 50 });
		const before = props([fx('b', 'jasper.flip-horizontal'), fx('a', 'jasper.crop', { left: 30 })]);
		expect(before.bounds).toEqual({ x: 30, y: 0, width: 70, height: 50 });
	});
});

describe('pinnedCropOf', () => {
	it('is the first effect when it is a crop, else null (a later crop is an ordinary stack effect)', () => {
		const c = crop({ left: 1 });
		expect(pinnedCropOf([c, mirror])).toBe(c);
		expect(pinnedCropOf([mirror, c])).toBeNull();
		expect(pinnedCropOf([])).toBeNull();
		expect(pinnedCropOf(undefined)).toBeNull();
	});
});
