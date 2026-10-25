// keyframe.applyEase with multi-point curves: key rebuild, exact timing, motion-path preservation (easing.md).
import { describe, expect, it } from 'vitest';
import { type Animatable, evaluate, evaluateEaseCurve, type MultiEase, type Vec2 } from '../src/index.ts';
import { distanceToPolyline, expectValid, setup } from './ease-helpers.ts';

type H = [number, number];
const pt = (x: number, y: number, inn?: H, out?: H) => ({
	x,
	y,
	...(inn ? { in: inn } : {}),
	...(out ? { out } : {}),
});

/** Overshoot past the end value and settle (one apex). */
const OVERSHOOT: MultiEase = {
	kind: 'multi',
	points: [pt(0, 0, undefined, [0.2, 0.5]), pt(0.6, 1.12, [0.45, 1.12], [0.75, 1.12]), pt(1, 1, [0.9, 1])],
};
/** Bounces off the end value: contacts at y = 1 and apexes between them (no flat piece). */
const BOUNCE: MultiEase = {
	kind: 'multi',
	points: [
		pt(0, 0, undefined, [0.2, 0]),
		pt(0.36, 1, [0.3, 0.8], [0.42, 0.85]),
		pt(0.54, 0.75, [0.48, 0.75], [0.6, 0.75]),
		pt(0.72, 1, [0.68, 0.9], [0.76, 0.9]),
		pt(0.81, 0.94, [0.78, 0.94], [0.84, 0.94]),
		pt(0.9, 1, [0.88, 0.97], [0.92, 0.97]),
		pt(0.95, 0.985, [0.935, 0.985], [0.965, 0.985]),
		pt(1, 1, [0.985, 0.995]),
	],
};
/** Elastic: alternating apexes around the end value. */
const ELASTIC: MultiEase = {
	kind: 'multi',
	points: [
		pt(0, 0, undefined, [0.1, 0.6]),
		pt(0.3, 1.25, [0.22, 1.25], [0.38, 1.25]),
		pt(0.5, 0.9, [0.44, 0.9], [0.56, 0.9]),
		pt(0.7, 1.05, [0.64, 1.05], [0.76, 1.05]),
		pt(0.85, 0.98, [0.8, 0.98], [0.9, 0.98]),
		pt(1, 1, [0.95, 1]),
	],
};
/** The last piece starts and ends at 1 but dips: cannot be held by equal-valued keys. */
const FLAT_DIP: MultiEase = {
	kind: 'multi',
	points: [pt(0, 0), pt(0.5, 1, undefined, [0.6, 0.8]), pt(1, 1, [0.9, 0.8])],
};

describe('keyframe.applyEase (multi-point curves)', () => {
	for (const [name, curve] of [
		['overshoot', OVERSHOOT],
		['bounce', BOUNCE],
		['elastic', ELASTIC],
	] as const) {
		it(`${name}: inner keys replaced, the motion equals the curve within 1e-6 (normalised)`, () => {
			const { h, key, anim } = setup();
			const ids = key('transform.rotation', [
				[0, 0],
				[25, 70],
				[60, 100],
				[90, 40],
			]);
			const before = structuredClone(anim<number>('transform.rotation'));
			const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[2]!], curve }]);
			const res = r.results[0] as { created: string[]; removed: string[] };
			expect(res.removed).toEqual([ids[1]]);
			expect(res.created.length).toBe(curve.points.length - 2);
			const a = anim<number>('transform.rotation');
			expect(a.keyframes.length).toBe(curve.points.length + 1);
			const t0 = before.keyframes[0]!.time;
			const t1 = before.keyframes[2]!.time;
			for (let k = 0; k <= 1000; k++) {
				const u = k / 1000;
				const v = evaluate(a, t0 + u * (t1 - t0));
				expect(Math.abs(v / 100 - evaluateEaseCurve(curve, u))).toBeLessThan(1e-6);
			}
			// The segment after the span is unchanged.
			const t3 = before.keyframes[3]!.time;
			for (let k = 0; k <= 20; k++) {
				const t = t1 + ((t3 - t1) * k) / 20;
				expect(evaluate(a, t)).toBeCloseTo(evaluate(before, t), 9);
			}
			expect(r.warnings.map((w) => w.code)).not.toContain('W_EASE_FLAT_SEGMENT');
			expectValid(h);
		});
	}

	it('a piece with equal end values is made linear with W_EASE_FLAT_SEGMENT', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[30, 50],
		]);
		const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: ids, curve: FLAT_DIP }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_EASE_FLAT_SEGMENT');
		const a = anim<number>('transform.rotation');
		const [k0, k1, k2] = a.keyframes;
		expect(evaluate(a, (k1!.time + k2!.time) / 2)).toBeCloseTo(50, 9);
		for (let k = 0; k <= 50; k++) {
			const u = k / 50;
			const v = evaluate(a, k0!.time + u * (k1!.time - k0!.time));
			expect(v / 50).toBeCloseTo(evaluateEaseCurve(FLAT_DIP, u / 2), 6);
		}
		expectValid(h);
	});

	it('values clamped by the property range warn W_VALUE_CLAMPED', () => {
		const { h, key } = setup();
		const ids = key('opacity', [
			[0, 0],
			[30, 100],
		]);
		const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: ids, curve: OVERSHOOT }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expectValid(h);
	});

	it('refuses equal end values, a single key, and sections without middle', () => {
		const { h, key } = setup();
		const ids = key('transform.rotation', [
			[0, 20],
			[15, 80],
			[30, 20],
		]);
		const eq = h.tx([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[2]!], curve: BOUNCE }]);
		expect(!eq.ok && eq.errors[0]!.code).toBe('E_INVALID_PARAM');
		if (!eq.ok) expect(eq.errors[0]!.message).toMatch(/first and last values are equal/);
		const one = h.tx([{ type: 'keyframe.applyEase', keyframeIds: [ids[1]!], curve: BOUNCE }]);
		expect(!one.ok && one.errors[0]!.code).toBe('E_INVALID_PARAM');
		const secs = h.tx([
			{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[1]!], curve: BOUNCE, sections: ['in', 'out'] },
		]);
		expect(!secs.ok && secs.errors[0]!.message).toMatch(/middle/);
	});

	it('roving keys in the span are cleared with a warning', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 30],
			[30, 60],
			[60, 100],
		]);
		h.ok([{ type: 'keyframe.setRoving', keyframeIds: [ids[1]!, ids[2]!], roving: true }]);
		const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[3]!], curve: ELASTIC }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_EASE_ROVING_CLEARED');
		expect(anim('transform.rotation').keyframes.some((k) => k.roving)).toBe(false);
		expectValid(h);
	});
});

describe('multi-point curves on a curved motion path (Position)', () => {
	function curved() {
		const s = setup();
		const ids = s.key('transform.position', [
			[0, [200, 800]],
			[20, [600, 300]],
			[45, [1100, 700]],
			[60, [1500, 400]],
		]);
		const before = structuredClone(s.anim<Vec2>('transform.position'));
		return { ...s, ids, before };
	}
	/** Dense polyline of the original drawn path between keys i and j (sampled through time). */
	function pathOf(a: Animatable<Vec2>, i: number, j: number, n = 1500): Vec2[] {
		const t0 = a.keyframes[i]!.time;
		const t1 = a.keyframes[j]!.time;
		return Array.from({ length: n + 1 }, (_, k) => evaluate(a, t0 + ((t1 - t0) * k) / n));
	}
	const arc = (poly: Vec2[]) => {
		const cum = [0];
		for (let k = 1; k < poly.length; k++)
			cum.push(cum[k - 1]! + Math.hypot(poly[k]![0] - poly[k - 1]![0], poly[k]![1] - poly[k - 1]![1]));
		return cum;
	};
	const pointAtFraction = (poly: Vec2[], cum: number[], f: number): Vec2 => {
		const L = cum[cum.length - 1]!;
		const s = f * L;
		let k = 1;
		while (k < cum.length - 1 && cum[k]! < s) k++;
		const q = (s - cum[k - 1]!) / Math.max(1e-12, cum[k]! - cum[k - 1]!);
		const p = poly[k - 1]!;
		const r = poly[k]!;
		return [p[0] + (r[0] - p[0]) * q, p[1] + (r[1] - p[1]) * q];
	};

	for (const [name, curve] of [
		['elastic', ELASTIC],
		['bounce', BOUNCE],
		['overshoot', OVERSHOOT],
	] as const) {
		it(`${name}: the drawn path is unchanged and the timing follows the curve by arc length`, () => {
			const { h, ids, before, anim } = curved();
			const r = h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[2]!], curve }]);
			const a = anim<Vec2>('transform.position');
			const orig = pathOf(before, 0, 2);
			const cum = arc(orig);
			const L = cum[cum.length - 1]!;
			const t0 = before.keyframes[0]!.time;
			const t1 = before.keyframes[2]!.time;
			// End tangent direction of the original path at B (for overshoot beyond it).
			const B = orig[orig.length - 1]!;
			const nb = orig[orig.length - 2]!;
			const dl = Math.hypot(B[0] - nb[0], B[1] - nb[1]);
			const dir: Vec2 = [(B[0] - nb[0]) / dl, (B[1] - nb[1]) / dl];
			let worstPath = 0;
			let worstTiming = 0;
			const moved: Vec2[] = [];
			for (let k = 0; k <= 400; k++) {
				const u = k / 400;
				const p = evaluate(a, t0 + u * (t1 - t0));
				moved.push(p);
				const y = evaluateEaseCurve(curve, u);
				const want: Vec2 =
					y <= 1
						? pointAtFraction(orig, cum, Math.max(0, y))
						: [B[0] + dir[0] * (y - 1) * L, B[1] + dir[1] * (y - 1) * L];
				worstTiming = Math.max(worstTiming, Math.hypot(p[0] - want[0], p[1] - want[1]));
				if (y >= 0 && y <= 1) worstPath = Math.max(worstPath, distanceToPolyline(p, orig));
			}
			// On the original path (sub-pixel), with the curve's timing to the arc-length tables' accuracy.
			expect(worstPath).toBeLessThan(0.05);
			expect(worstTiming / L).toBeLessThan(2e-3);
			// Every original path point is still drawn.
			let cover = 0;
			for (let k = 0; k < orig.length; k += 50) cover = Math.max(cover, distanceToPolyline(orig[k]!, moved));
			expect(cover).toBeLessThan(0.5);
			// The segment after the span is unchanged.
			const t3 = before.keyframes[3]!.time;
			for (let k = 0; k <= 20; k++) {
				const t = t1 + ((t3 - t1) * k) / 20;
				const p = evaluate(a, t);
				const q = evaluate(before, t);
				expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-6);
			}
			// The arriving / leaving tangents of the span's ends kept the outside segments.
			expect(r.warnings.map((w) => w.code)).not.toContain('W_EASE_SKIPPED');
			expectValid(h);
		});
	}
});
