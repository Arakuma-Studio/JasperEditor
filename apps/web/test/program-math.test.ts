import { applyMatrix, type LayerTransformValues, layerMatrix } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { buildSnapTargets, snapAxis, snapMove, snapThreshold } from '../src/panels/program/snapping.ts';
import {
	angleDelta,
	type HandleId,
	hitTest,
	moveAnchor,
	pointInQuad,
	RotationTracker,
	rotate,
	scaleFromHandle,
	snapRotation,
	type Vec2,
} from '../src/panels/program/transform-math.ts';
import {
	clampPan,
	computeView,
	toScreen,
	toSequence,
	zoomAround,
	zoomPercent,
} from '../src/panels/program/viewport.ts';

const FRAME = { width: 1920, height: 1080 };

describe('viewport (S03:PGM-010…014)', () => {
	it('zooms around the cursor keeping the sequence point fixed within 1 px (AC-PGM-3)', () => {
		const vp = { width: 1200, height: 800 };
		let state: { zoom: 'fit' | number; pan: Vec2 } = { zoom: 'fit', pan: [0, 0] };
		const anchor: Vec2 = [700, 300];
		const before = toSequence(computeView(vp, FRAME, state.zoom, state.pan), anchor);
		for (const factor of [1.1, 1.1, 1.1, 2, 0.5, 3]) {
			const pct = zoomPercent(state.zoom, vp, FRAME) * factor;
			state = zoomAround(vp, FRAME, state, pct, anchor);
			const v = computeView(vp, FRAME, state.zoom, state.pan);
			const back = toScreen(v, before);
			expect(Math.abs(back[0] - anchor[0])).toBeLessThanOrEqual(1);
			expect(Math.abs(back[1] - anchor[1])).toBeLessThanOrEqual(1);
		}
	});

	it('clamps pan so at least 10 % / 48 px of the frame stays visible', () => {
		const vp = { width: 800, height: 600 };
		const [px, py] = clampPan([100000, -100000], vp, FRAME, 1);
		const v = computeView(vp, FRAME, 100, [px, py]);
		expect(v.x).toBeLessThanOrEqual(800 - 192 + 1e-9);
		expect(v.y + 1080).toBeGreaterThanOrEqual(108 - 1e-9);
	});
});

// A layer rotated 37° with 150 %/80 % non-uniform scale and a 20 % left crop (AC-XF-1).
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
// The eight points and their opposites in the specified cropped fixture (AC-XF-1 / XF-031).
const HANDLES: readonly [HandleId, Vec2, Vec2][] = [
	['nw', [128, 0], [640, 360]],
	['n', [384, 0], [384, 360]],
	['ne', [640, 0], [128, 360]],
	['e', [640, 180], [128, 180]],
	['se', [640, 360], [128, 0]],
	['s', [384, 360], [384, 0]],
	['sw', [128, 360], [640, 0]],
	['w', [128, 180], [640, 180]],
];

function screenOf(v: LayerTransformValues, q: Vec2, scale: number): Vec2 {
	const p = applyMatrix(layerMatrix(v), q);
	return [p[0] * scale, p[1] * scale];
}

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
		// mirrored winding still hits
		expect(pointInQuad([5, 5], [...q(0, 0, 10)].reverse())).toBe(true);
	});

	it('moves every handle onto the cursor with ≤ 1 screen px error at 25/100/400 % (AC-XF-1)', () => {
		for (const zoom of [0.25, 1, 4]) {
			for (const [h, qh] of HANDLES) {
				// Target: the handle position after a free scale to 120 % × 60 % (edges: their axis only).
				const target: LayerTransformValues = {
					...V,
					scaleWidth: h === 'n' || h === 's' ? V.scaleWidth : 120,
					scale: h === 'e' || h === 'w' ? V.scale : 60,
				};
				const wanted = applyMatrix(layerMatrix(target), qh) as Vec2;
				const r = scaleFromHandle({ values: V, rect: RECT, handle: h, pointer: wanted });
				const next = {
					...V,
					scale: r.scale,
					scaleWidth: r.scaleWidth,
					uniformScale: r.uniformScale,
					position: r.position,
				};
				const got = screenOf(next, qh, zoom);
				const exp: Vec2 = [wanted[0] * zoom, wanted[1] * zoom];
				expect(Math.hypot(got[0] - exp[0], got[1] - exp[1])).toBeLessThanOrEqual(1);
				// edges change only their own axis
				if (h === 'e' || h === 'w') expect(r.scale).toBeCloseTo(V.scale, 9);
				if (h === 'n' || h === 's') expect(r.scaleWidth).toBeCloseTo(V.scaleWidth, 9);
			}
		}
	});

	it('keeps the opposite handle fixed with Alt and writes position (XF-031)', () => {
		for (const [h, qh, opp] of HANDLES) {
			const before = applyMatrix(layerMatrix(V), opp);
			const pointer = applyMatrix(layerMatrix({ ...V, scaleWidth: 200, scale: 100 }), qh) as Vec2;
			const r = scaleFromHandle({ values: V, rect: RECT, handle: h, pointer, aboutOpposite: true });
			const after = applyMatrix(
				layerMatrix({ ...V, scale: r.scale, scaleWidth: r.scaleWidth, position: r.position }),
				opp,
			);
			expect(after[0]).toBeCloseTo(before[0], 6);
			expect(after[1]).toBeCloseTo(before[1], 6);
		}
	});

	it('scales uniformly by projection on corners and clamps instead of flipping (XF-030/032)', () => {
		const u: LayerTransformValues = { ...V, uniformScale: true, scale: 100, scaleWidth: 100 };
		const corner: Vec2 = [640, 360];
		const doubled = applyMatrix(layerMatrix({ ...u, scale: 200, scaleWidth: 200 }), corner) as Vec2;
		const r = scaleFromHandle({
			values: u,
			rect: RECT,
			handle: 'se',
			pointer: [doubled[0] + 3, doubled[1] - 2],
		});
		expect(r.uniformScale).toBe(true);
		expect(r.scale).toBeCloseTo(r.scaleWidth, 9);
		expect(r.scale).toBeGreaterThan(195);
		expect(r.scale).toBeLessThan(205);
		const through = scaleFromHandle({ values: u, rect: RECT, handle: 'se', pointer: [0, 0] });
		expect(through.scale).toBe(0.1);
		// Shift inverts uniform → free scaling
		expect(
			scaleFromHandle({ values: u, rect: RECT, handle: 'se', pointer: doubled, invertUniform: true })
				.uniformScale,
		).toBe(false);
	});

	it('rotates with unwrapping, Shift 15° steps and the 90° snap (XF-035)', () => {
		const c: Vec2 = [0, 0];
		const t = new RotationTracker(c, [100, 0], 10);
		let theta = 0;
		for (let a = 10; a <= 720; a += 10) theta = t.update(rotate([100, 0], a));
		expect(theta).toBeCloseTo(730, 6);
		expect(angleDelta(170, -170)).toBeCloseTo(20, 9);
		expect(snapRotation(37, { shift: true })).toBe(30);
		expect(snapRotation(91.5, { snap90: true })).toBe(90);
		expect(snapRotation(93, { snap90: true })).toBe(93);
	});

	it('moves the anchor without moving the image (XF-037, AC-XF-2 logic)', () => {
		const { anchor, position } = moveAnchor(V, [37, -12]);
		const next = { ...V, anchor, position };
		for (const q of [
			[0, 0],
			[640, 0],
			[640, 360],
			[100, 250],
		] as Vec2[]) {
			const a = applyMatrix(layerMatrix(V), q);
			const b = applyMatrix(layerMatrix(next), q);
			expect(b[0]).toBeCloseTo(a[0], 9);
			expect(b[1]).toBeCloseTo(a[1], 9);
		}
		// the crosshair lands where the pointer moved
		const cross = applyMatrix(layerMatrix(next), anchor);
		expect(cross[0]).toBeCloseTo(V.position[0] + 37, 9);
		expect(cross[1]).toBeCloseTo(V.position[1] - 12, 9);
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
