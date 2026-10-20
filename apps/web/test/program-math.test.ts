import type { LayerTransformValues } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { buildSnapTargets, snapAxis, snapMove, snapThreshold } from '../src/panels/program/snapping.ts';
import {
	angleDelta,
	hitTest,
	moveAnchor,
	pointInQuad,
	RotationTracker,
	scaleFromHandle,
	snapRotation,
	type Vec2,
} from '../src/panels/program/transform-math.ts';
import { clampPan, computeView, toScreen, toSequence, zoomAround } from '../src/panels/program/viewport.ts';

const FRAME = { width: 1920, height: 1080 };

describe('viewport (S03:PGM-010…014)', () => {
	it('zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3)', () => {
		const vp = { width: 1952, height: 1112 };
		const state = { zoom: 'fit' as const, pan: [0, 0] as Vec2 };
		const anchor: Vec2 = [1116, 416];
		// PGM-012: 16 px padding gives fit scale 1 and origin (16,16).
		expect(computeView(vp, FRAME, 'fit', [0, 0])).toEqual({ scale: 1, x: 16, y: 16 });
		expect(toSequence({ scale: 1, x: 16, y: 16 }, anchor)).toEqual([1100, 400]);
		for (const [percent, pan] of [
			[25, [105, -105]],
			[100, [0, 0]],
			[400, [-420, 420]],
		] as const) {
			const next = zoomAround(vp, FRAME, state, percent, anchor);
			expect(next).toEqual({ zoom: percent, pan });
			const view = computeView(vp, FRAME, next.zoom, next.pan);
			expect(toScreen(view, [1100, 400])).toEqual([1116, 416]);
		}
	});

	it('clamps pan so at least 10 % / 48 px of the frame stays visible', () => {
		const vp = { width: 800, height: 600 };
		expect(clampPan([100000, -100000], vp, FRAME, 1)).toEqual([1168, -732]);
		expect(clampPan([100000, -100000], vp, FRAME, 0.1)).toEqual([448, -306]);
	});
});

// A layer rotated 37° with 150 %/80 % non-uniform scale and a 20 % left crop.
const V: LayerTransformValues = {
	position: [900, 500],
	anchor: [320, 180],
	scale: 80,
	scaleWidth: 150,
	uniformScale: false,
	rotation: 37,
	flipH: false,
	flipV: false,
};
const RECT = { x: 128, y: 0, width: 512, height: 360 };
describe('on-canvas transform math (S03 §9)', () => {
	it('picks the topmost layer whose quad contains the point, skipping locked tracks (XF-001)', () => {
		const q = (x: number, y: number, s: number) =>
			[
				[x, y],
				[x + s, y],
				[x + s, y + s],
				[x, y + s],
			] as [Vec2, Vec2, Vec2, Vec2];
		const layers = [
			{ clipId: 'a', trackId: 'V1', quad: q(0, 0, 100) },
			{ clipId: 'b', trackId: 'V2', quad: q(50, 50, 100) },
		];
		expect(hitTest(layers, [75, 75])).toBe('b');
		expect(hitTest(layers, [75, 75], new Set(['V2']))).toBe('a');
		expect(hitTest(layers, [10, 10])).toBe('a');
		expect(hitTest(layers, [300, 300])).toBeNull();
		expect(pointInQuad([5, 5], [...q(0, 0, 10)].reverse())).toBe(true);
	});

	it('maps all eight rotated, cropped handle drags to the requested scales (XF-029/030, AC-XF-1)', () => {
		// Independent S03 §3.2 coordinates: P + R(37°)·diag(sx,sy)·(q−A).
		// Target scales are 120%/60%; edge handles preserve the untouched axis.
		for (const [handle, x, y, width, height] of [
			['nw', 780.99040099, 275.08918358, 120, 60],
			['n', 1041.66503146, 471.52160714, 150, 60],
			['ne', 1271.67205836, 644.84433381, 120, 60],
			['e', 1206.67603586, 731.09696889, 120, 80],
			['se', 1141.68001336, 817.34960398, 120, 60],
			['s', 911.67298646, 644.02687731, 150, 60],
			['sw', 650.99835598, 447.59445375, 120, 60],
			['w', 715.99437849, 361.34181867, 120, 80],
		] as const) {
			const result = scaleFromHandle({ values: V, rect: RECT, handle, pointer: [x, y] });
			expect(result.scaleWidth).toBeCloseTo(width, 6);
			expect(result.scale).toBeCloseTo(height, 6);
		}
	});

	it('keeps the opposite handle fixed with Alt and writes position (XF-031)', () => {
		// At 90°, the initial layer map is x'=900−0.8(y−180), y'=500+1.5(x−320).
		// These literal targets use 200%/100% while leaving each opposite point fixed.
		for (const [handle, x, y, px, py, width, height] of [
			['nw', 1116, -44, 936, 340, 200, 100],
			['n', 1116, 596, 936, 500, 150, 100],
			['ne', 1116, 1236, 936, 596, 200, 100],
			['e', 900, 1236, 900, 596, 200, 80],
			['se', 684, 1236, 864, 596, 200, 100],
			['s', 684, 596, 864, 500, 150, 100],
			['sw', 684, -44, 864, 340, 200, 100],
			['w', 900, -44, 900, 340, 200, 80],
		] as const) {
			const result = scaleFromHandle({
				values: { ...V, rotation: 90 },
				rect: RECT,
				handle,
				pointer: [x, y],
				aboutOpposite: true,
			});
			expect(result.scaleWidth).toBeCloseTo(width, 6);
			expect(result.scale).toBeCloseTo(height, 6);
			expect(result.position[0]).toBeCloseTo(px, 6);
			expect(result.position[1]).toBeCloseTo(py, 6);
		}
	});

	it('scales uniformly by projection on corners and clamps instead of flipping (XF-030/032)', () => {
		const u: LayerTransformValues = { ...V, uniformScale: true, scale: 100, scaleWidth: 100 };
		// S03 §3.2 applied to corner (640,360) at uniform 200%.
		const doubled: Vec2 = [1194.47331809553, 1172.6703984343362];
		const r = scaleFromHandle({
			values: u,
			rect: RECT,
			handle: 'se',
			// A perpendicular offset from the doubled corner leaves its projection at 200%.
			pointer: [1160.8397981738133, 1187.3940643391127],
		});
		expect(r.uniformScale).toBe(true);
		expect(r.scale).toBeCloseTo(200, 9);
		expect(r.scaleWidth).toBeCloseTo(200, 9);
		const through = scaleFromHandle({ values: u, rect: RECT, handle: 'se', pointer: [0, 0] });
		expect(through.scale).toBe(0.1);
		expect(
			scaleFromHandle({ values: u, rect: RECT, handle: 'se', pointer: doubled, invertUniform: true })
				.uniformScale,
		).toBe(false);
	});

	it('rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035)', () => {
		const c: Vec2 = [0, 0];
		const t = new RotationTracker(c, [100, 0], 10);
		let theta = 0;
		for (let turn = 0; turn < 2; turn++) {
			for (const point of [
				[0, 100],
				[-100, 0],
				[0, -100],
				[100, 0],
			] as Vec2[])
				theta = t.update(point);
		}
		expect(theta).toBeCloseTo(730, 6);
		expect(angleDelta(170, -170)).toBeCloseTo(20, 9);
		expect(snapRotation(37, { shift: true })).toBe(30);
		expect(snapRotation(91.5, { snap90: true })).toBe(90);
		expect(snapRotation(93, { snap90: true })).toBe(93);
	});

	it('moves the anchor without moving the image (XF-037, AC-XF-2 logic)', () => {
		const result = moveAnchor(V, [37, -12]);
		// XF-037: inverse 37° rotation, then divide by 150%/80%; P advances by the drag.
		expect(result.anchor[0]).toBeCloseTo(334.8851557292835, 9);
		expect(result.anchor[1]).toBeCloseTo(140.18652252850836, 9);
		expect(result.position).toEqual([937, 488]);
	});
});

describe('spatial snapping (S03 §10)', () => {
	it('engages within 6 ± 1 screen px at 50 % and 200 % (AC-SNP-1)', () => {
		const targets = buildSnapTargets({ width: 1920, height: 1080 });
		for (const scale of [0.5, 2]) {
			const tau = snapThreshold(scale);
			const near = snapAxis([{ value: 960 + 5.5 / scale, role: 'min' }], targets.x, tau);
			const far = snapAxis([{ value: 960 + 7 / scale, role: 'min' }], targets.x, tau);
			expect(near?.delta).toBeCloseTo(-5.5 / scale, 9);
			expect(far).toBeNull();
		}
	});

	it('prefers the nearest target, then center-to-center (AC-SNP-2)', () => {
		const t = [
			{ value: 103, kind: 'layer' as const, role: 'min' as const },
			{ value: 96, kind: 'layer' as const, role: 'min' as const },
		];
		expect(snapAxis([{ value: 100, role: 'min' }], t, 6)?.target.value).toBe(103);
		const tie = [
			{ value: 104, kind: 'frame' as const, role: 'max' as const },
			{ value: 96, kind: 'layer' as const, role: 'center' as const },
		];
		expect(snapAxis([{ value: 100, role: 'center' }], tie, 6)?.target.value).toBe(96);
		const moved = snapMove({ x: 3, y: 540 - 50 + 2, width: 100, height: 100 }, buildSnapTargets(FRAME), 6);
		expect(moved.dx).toBe(-3);
		expect(moved.dy).toBe(-2);
	});
});
