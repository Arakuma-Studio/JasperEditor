// The keyframe assistant (easing) under per-side interpolation and effect-point pixel metrics: every read goes through
// the evaluator's `segmentShape` (a segment uses its left key's outgoing side and its right key's incoming side,
// docs/wp-notes/keyframe-sides.md) and every write makes the evaluator return the requested curve while every other
// segment evaluates bit-identically; effect points measure their path lengths in the layer box's pixels
// (docs/wp-notes/spatial-points.md). docs/wp-notes/easing.md § Per-side segments.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type CubicEase,
	copyEase,
	describeKeyframeEases,
	type Ease,
	evaluate,
	evaluateEaseCurve,
	type InInterpolation,
	type Interpolation,
	type Keyframe,
	type MultiEase,
	type SpatialMetric,
	segmentShape,
	type Vec2,
} from '../src/index.ts';
import { cssCubic, distanceToPolyline, expectValid, setup } from './ease-helpers.ts';
import { Harness } from './helpers.ts';

const INTERPS: Interpolation[] = ['linear', 'bezier', 'auto-bezier', 'continuous-bezier', 'hold'];
const bothSided = (t: Interpolation) => t === 'auto-bezier' || t === 'continuous-bezier';
const SIXTH: Ease = { influence: 1 / 6, slope: 1 };

const easeArb = fc.record({
	influence: fc.double({ min: 0.05, max: 1, noNaN: true }),
	slope: fc.double({ min: -2, max: 3, noNaN: true }),
});

/** A key's side types: read the legacy way (no `inInterpolation`) or per side, as INV-011 allows. */
const sidesArb = fc
	.record({
		interpolation: fc.constantFrom(...INTERPS),
		choice: fc.constantFrom('legacy', 'same', 'linear', 'bezier'),
	})
	.map(({ interpolation, choice }): { interpolation: Interpolation; inInterpolation?: InInterpolation } => {
		if (choice === 'legacy') return { interpolation };
		if (choice === 'same' || bothSided(interpolation))
			return { interpolation, inInterpolation: interpolation === 'hold' ? 'bezier' : interpolation };
		return { interpolation, inInterpolation: choice as InInterpolation };
	});

const cubicArb = fc.record({
	kind: fc.constant('cubic' as const),
	x1: fc.double({ min: 0.01, max: 1, noNaN: true }),
	y1: fc.double({ min: -2, max: 3, noNaN: true }),
	x2: fc.double({ min: 0, max: 0.99, noNaN: true }),
	y2: fc.double({ min: -2, max: 3, noNaN: true }),
});

/** Rotation keys at frames 0, 10, 20, … from keyframe.add with explicit sides. */
function rotationKeys(
	h: Harness,
	clipId: string,
	keys: {
		value: number;
		interpolation: Interpolation;
		inInterpolation?: InInterpolation;
		easeIn: Ease;
		easeOut: Ease;
	}[],
) {
	h.ok(
		keys.map((k, i) => ({
			type: 'keyframe.add',
			target: ['clip', clipId, 'transform', 'rotation'],
			at: { sequenceFrame: i * 10 },
			value: k.value,
			interpolation: k.interpolation,
			...(k.inInterpolation ? { inInterpolation: k.inInterpolation } : {}),
			easeIn: k.easeIn,
			easeOut: k.easeOut,
		})),
	);
}

describe('keyframe.applyEase on mixed legacy / per-side keys (commands)', () => {
	it('property: the chosen segment is the cubic, the others evaluate as before, invariants hold, undo / redo', () => {
		const keyArb = fc.record({
			value: fc.integer({ min: -180, max: 180 }),
			sides: sidesArb,
			easeIn: easeArb,
			easeOut: easeArb,
		});
		fc.assert(
			fc.property(
				fc.array(keyArb, { minLength: 2, maxLength: 5 }),
				fc.nat(),
				cubicArb,
				(spec, pick, curve) => {
					const { h, id, anim } = setup();
					rotationKeys(
						h,
						id,
						spec.map((s) => ({ value: s.value, ...s.sides, easeIn: s.easeIn, easeOut: s.easeOut })),
					);
					const rot = () => anim<number>('transform.rotation');
					const before = structuredClone(rot());
					const docBefore = h.doc;
					const ids = before.keyframes.map((k) => k.id);
					const a = pick % (ids.length - 1);
					const command = { type: 'keyframe.applyEase', keyframeIds: [ids[a]!, ids[a + 1]!], curve };
					h.ok([command]);
					expectValid(h);
					const after = rot();
					const t = before.keyframes.map((k) => k.time);
					const v0 = before.keyframes[a]!.value;
					const v1 = before.keyframes[a + 1]!.value;
					for (let k = 0; k < 20; k++) {
						const u = k / 20;
						const want = v0 + cssCubic(curve as CubicEase, u) * (v1 - v0);
						expect(Math.abs(evaluate(after, t[a]! + u * (t[a + 1]! - t[a]!)) - want)).toBeLessThan(
							1e-6 * (1 + Math.abs(v1 - v0)),
						);
					}
					for (let s = 0; s < t.length - 1; s++) {
						if (s === a) continue;
						for (let k = 0; k <= 20; k++) {
							const at = t[s]! + ((t[s + 1]! - t[s]!) * k) / 20;
							expect(Object.is(evaluate(after, at), evaluate(before, at))).toBe(true);
						}
					}
					// Undo is a document swap (the previous document is untouched); redo is deterministic.
					const result = structuredClone(after);
					h.doc = docBefore;
					expect(rot()).toEqual(before);
					h.ok([command]);
					expect(rot()).toEqual(result);
				},
			),
			{ numRuns: 60, seed: 5 },
		);
	});
});

describe('keyframe.applyEase on effect points', () => {
	it('keeps outside Auto Bezier segments in layer pixels when the middle span changes', () => {
		const h = new Harness();
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [1, 0, 0, 1] }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.transform', ref: '$fx' }]);
		const fxId = (h.seq.clips[id] as { effects: { id: string }[] }).effects[0]!.id;
		const target = ['effect', fxId, 'position'];
		const r = h.ok(
			[
				[0.1, 0.2],
				[0.2, 0.9],
				[0.8, 0.4],
				[0.9, 0.8],
			].map((value, i) => ({
				type: 'keyframe.add',
				target,
				at: { sequenceFrame: i * 30 },
				value,
				interpolation: 'auto-bezier',
				inInterpolation: 'auto-bezier',
				ref: `$k${i}`,
			})),
		);
		const pos = () =>
			(
				h.seq.clips[id] as unknown as {
					effects: { params: { position: Animatable<Vec2> } }[];
				}
			).effects[0]!.params.position;
		const before = structuredClone(pos());
		const times = before.keyframes.map((k) => k.time);
		h.ok([
			{
				type: 'keyframe.applyEase',
				keyframeIds: [r.refs.$k1, r.refs.$k2],
				curve: { kind: 'cubic', x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
			},
		]);
		expectValid(h);
		for (const span of [0, 2]) {
			for (let k = 0; k <= 20; k++) {
				const at = times[span]! + ((times[span + 1]! - times[span]!) * k) / 20;
				const want = evaluate(before, at, { metric: [1920, 1080] });
				const got = evaluate(pos(), at, { metric: [1920, 1080] });
				got.forEach((v, c) => {
					expect(v).toBeCloseTo(want[c]!, 12);
				});
			}
		}
		const at = times[1]! + (times[2]! - times[1]!) / 4;
		expect(evaluate(pos(), at, { metric: [1920, 1080] })).not.toEqual(
			evaluate(before, at, { metric: [1920, 1080] }),
		);
	});
});

describe('ease clipboard with side types', () => {
	it('copies both sides with their types; pasting sets them like keyframe.setInterpolation (Premiere / AE)', () => {
		const { h, id, key, anim } = setup();
		// Source: key 1 = Premiere Ease In (Bezier incoming {⅓, 0}) with a Linear outgoing side.
		rotationKeys(h, id, [
			{ value: 0, interpolation: 'linear', easeIn: SIXTH, easeOut: SIXTH },
			{
				value: 60,
				interpolation: 'linear',
				inInterpolation: 'bezier',
				easeIn: { influence: 1 / 3, slope: 0 },
				easeOut: SIXTH,
			},
			{ value: 90, interpolation: 'linear', inInterpolation: 'linear', easeIn: SIXTH, easeOut: SIXTH },
		]);
		const src = anim<number>('transform.rotation').keyframes.map((k) => k.id);
		const c = copyEase(h.doc, [src[1]!]);
		if (!c.ok) throw new Error(c.message);
		expect(c.clip).toEqual({
			kind: 'key',
			easeIn: { influence: 1 / 3, slope: 0 },
			easeOut: SIXTH,
			inInterpolation: 'bezier',
			interpolation: 'linear',
		});
		// Target: legacy Linear keys (read the legacy way).
		const dst = key('opacity', [
			[0, 0],
			[10, 80],
			[20, 100],
		]);
		const op = () => anim<number>('opacity');
		const prevKey = structuredClone(op().keyframes[0]!);
		h.ok([{ type: 'keyframe.pasteEase', keyframeIds: [dst[1]!], clip: c.clip }]);
		expectValid(h);
		const k = op().keyframes;
		expect(k[1]).toMatchObject({
			interpolation: 'linear',
			inInterpolation: 'bezier',
			easeIn: { influence: 1 / 3, slope: 0 },
		});
		// The neighbour keeps its own (Linear, legacy) key; the segment into the target eases in with AE's ⅙ on the
		// Linear side, the segment after it stays linear (both sides Linear).
		expect(k[0]).toEqual(prevKey);
		expect(segmentShape(k, 0, 1)).toEqual({ out: SIXTH, in: { influence: 1 / 3, slope: 0 } });
		expect(segmentShape(k, 1, 2)).toBe('linear');
		// Copying the target back gives the same clip.
		const back = copyEase(h.doc, [dst[1]!]);
		expect(back.ok && back.clip).toEqual(c.clip);
		// The source and the target segments now evaluate alike (same normalised shape).
		const src0 = anim<number>('transform.rotation');
		for (let f = 0; f <= 10; f++) {
			const t = (f / 10) * k[1]!.time;
			const ps = evaluate(src0, (f / 10) * src0.keyframes[1]!.time) / 60;
			expect(evaluate(op(), t) / 80).toBeCloseTo(ps, 12);
		}
	});

	it('a legacy Auto Bezier key after a Linear key copies as Linear in / Bezier out at its computed ease', () => {
		const { h, key, anim } = setup();
		const ids = key('transform.rotation', [
			[0, 0],
			[10, 40],
			[20, 100],
		]);
		const kfs = structuredClone(anim<number>('transform.rotation').keyframes) as Keyframe<unknown>[];
		kfs[1]!.interpolation = 'auto-bezier';
		h.ok([{ type: 'keyframe.setInterpolation', keyframeIds: [ids[1]!], interpolation: 'auto-bezier' }]);
		// keyframe.setInterpolation made key 1 per side (incoming Auto) and key 2's incoming explicit.
		const c = copyEase(h.doc, [ids[1]!]);
		if (!c.ok || c.clip.kind !== 'key') throw new Error('no key clip');
		expect(c.clip.inInterpolation).toBe('auto-bezier');
		expect(c.clip.interpolation).toBe('auto-bezier');
		// A legacy Auto key after a Linear key: its arriving segment is linear, so it copies Linear in, Bezier out.
		const legacy: Keyframe<unknown>[] = structuredClone(kfs);
		const { h: h2, id: id2, anim: anim2 } = setup();
		rotationKeys(
			h2,
			id2,
			legacy.map((k) => ({
				value: k.value as number,
				interpolation: k.interpolation,
				easeIn: k.easeIn,
				easeOut: k.easeOut,
			})),
		);
		const ids2 = anim2<number>('transform.rotation').keyframes.map((k) => k.id);
		const c2 = copyEase(h2.doc, [ids2[1]!]);
		if (!c2.ok || c2.clip.kind !== 'key') throw new Error('no key clip');
		expect(c2.clip.inInterpolation).toBe('linear');
		expect(c2.clip.interpolation).toBe('bezier');
		// Centred speed (100 − 0) / 20 divided by outgoing average (100 − 40) / 10 = 5/6.
		expect(c2.clip.easeOut.influence).toBe(1 / 3);
		expect(c2.clip.easeOut.slope).toBeCloseTo(5 / 6, 12);
	});

	it('a clip without types (older clipboard entries, agents) pastes Bezier sides', () => {
		const { h, key, anim } = setup();
		const ids = key('opacity', [
			[0, 0],
			[10, 50],
			[20, 100],
		]);
		h.ok([
			{
				type: 'keyframe.pasteEase',
				keyframeIds: [ids[1]!],
				clip: { kind: 'key', easeIn: { influence: 0.5, slope: 0 }, easeOut: { influence: 0.5, slope: 0 } },
			},
		]);
		expectValid(h);
		const k = anim<number>('opacity').keyframes;
		expect(k[1]).toMatchObject({ interpolation: 'bezier', inInterpolation: 'bezier' });
		expect(segmentShape(k, 0, 1)).toEqual({ out: SIXTH, in: { influence: 0.5, slope: 0 } });
		expect(segmentShape(k, 1, 2)).toEqual({ out: { influence: 0.5, slope: 0 }, in: SIXTH });
	});
});

describe('describeKeyframeEases reports sides', () => {
	it('per-side segments: side types, the ⅙ Linear side and the per-key incoming type', () => {
		const { h, id, anim } = setup();
		rotationKeys(h, id, [
			{ value: 0, interpolation: 'linear', easeIn: SIXTH, easeOut: SIXTH },
			{
				value: 90,
				interpolation: 'hold',
				inInterpolation: 'bezier',
				easeIn: { influence: 0.5, slope: 0 },
				easeOut: SIXTH,
			},
			{ value: 0, interpolation: 'linear', easeIn: SIXTH, easeOut: SIXTH },
		]);
		const ids = anim<number>('transform.rotation').keyframes.map((k) => k.id);
		const d = describeKeyframeEases(h.doc, [ids[1]!]);
		if (!d.ok) throw new Error(d.message);
		const p = d.properties[0]!;
		expect(p.keys[0]!.inInterpolation).toBe('bezier');
		expect(p.keys[0]!.easeIn).toMatchObject({ interpolation: 'bezier', influence: 0.5, slope: 0 });
		expect(p.keys[0]!.easeOut).toMatchObject({ interpolation: 'hold' });
		const [into, out] = p.segments;
		expect(into).toMatchObject({
			hold: false,
			linear: false,
			outInterpolation: 'linear',
			inInterpolation: 'bezier',
		});
		expect(into!.curve.x1).toBeCloseTo(1 / 6, 12);
		expect(into!.curve.y1).toBeCloseTo(1 / 6, 12);
		expect(out).toMatchObject({ hold: true, outInterpolation: 'hold', inInterpolation: 'hold' });
	});
});

describe('effect points: rebuilds and clean-up in the layer box pixels', () => {
	const W = 1920;
	const H = 1080;
	const M: SpatialMetric = [W, H];
	const px = (v: readonly number[]): Vec2 => [v[0]! * W, v[1]! * H];

	/** Transform Position keys (normalised) on a 1920 × 1080 solid: an arch, Linear temporal (constant px speed). */
	function arch() {
		const h = new Harness();
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [1, 0, 0, 1] }]);
		const id = h.clips('V1')[0]!.id;
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.transform' }]);
		type FxClip = { effects: { id: string; params: Record<string, Animatable<Vec2>> }[] };
		const fx = () => (h.seq.clips[id] as unknown as FxClip).effects[0]!;
		const target = ['effect', fx().id, 'position'];
		h.ok([
			{ type: 'param.setAnimated', target, animated: true, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target, value: [0.1, 0.85], at: { sequenceFrame: 0 } },
			{ type: 'param.set', target, value: [0.3, 0.15], at: { sequenceFrame: 40 } },
			{ type: 'param.set', target, value: [0.9, 0.5], at: { sequenceFrame: 90 } },
		]);
		return { h, pos: () => fx().params.position! };
	}

	/** The point at pixel arc-length fraction s of the original path, from a dense constant-px-speed sampling. */
	function referenceAlong(a: Animatable<Vec2>, t0: number, t1: number) {
		// Constant speed per segment, not across segments: sample densely and measure the polyline in px.
		const N = 40_000;
		const pts: Vec2[] = [];
		for (let j = 0; j <= N; j++) pts.push(px(evaluate(a, t0 + ((t1 - t0) * j) / N, { metric: M })));
		const cum = [0];
		for (let j = 1; j <= N; j++)
			cum.push(cum[j - 1]! + Math.hypot(pts[j]![0] - pts[j - 1]![0], pts[j]![1] - pts[j - 1]![1]));
		const total = cum[N]!;
		return (s: number): Vec2 => {
			const target = s * total;
			let lo = 0;
			let hi = N;
			while (hi - lo > 1) {
				const mid = (lo + hi) >> 1;
				if (cum[mid]! <= target) lo = mid;
				else hi = mid;
			}
			const f = cum[hi]! > cum[lo]! ? (target - cum[lo]!) / (cum[hi]! - cum[lo]!) : 0;
			return [pts[lo]![0] + f * (pts[hi]![0] - pts[lo]![0]), pts[lo]![1] + f * (pts[hi]![1] - pts[lo]![1])];
		};
	}

	const CURVE: MultiEase = {
		kind: 'multi',
		points: [
			{ x: 0, y: 0 },
			{ x: 0.3, y: 0.55, out: [0.4, 0.75] },
			{ x: 0.7, y: 0.9, in: [0.6, 0.85] },
			{ x: 1, y: 1 },
		],
	};

	it('a multi-point rebuild follows the curve in layer px along the unchanged path', () => {
		const { h, pos } = arch();
		const before = structuredClone(pos());
		const t0 = before.keyframes[0]!.time;
		const t1 = before.keyframes[2]!.time;
		const ref = referenceAlong(before, t0, t1);
		const ids = before.keyframes.map((k) => k.id);
		h.ok([{ type: 'keyframe.applyEase', keyframeIds: [ids[0]!, ids[2]!], curve: CURVE }]);
		expectValid(h);
		const after = pos();
		let worst = 0;
		for (let k = 0; k <= 100; k++) {
			const x = k / 100;
			const want = ref(evaluateEaseCurve(CURVE, x));
			const got = px(evaluate(after, t0 + x * (t1 - t0), { metric: M }));
			worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1]));
		}
		expect(worst).toBeLessThan(0.75);
	});

	it('clean up path: tolerance in layer px, the timing linear in px, outside segments unchanged', () => {
		const { h, pos } = arch();
		const before = structuredClone(pos());
		const ids = before.keyframes.map((k) => k.id);
		// Linear in → Ease In key 2 per side (keyframe-sides), so the segment arriving at the last key is per side.
		h.ok([
			{
				type: 'keyframe.setInterpolation',
				keyframeIds: [ids[2]!],
				interpolation: 'bezier',
				easeIn: { influence: 1 / 3, slope: 0 },
				side: 'in',
			},
		]);
		const t0 = before.keyframes[0]!.time;
		const t1 = before.keyframes[2]!.time;
		const original: Vec2[] = [];
		for (let j = 0; j <= 4000; j++)
			original.push(px(evaluate(before, t0 + ((t1 - t0) * j) / 4000, { metric: M })));
		const r = h.ok([{ type: 'keyframes.cleanupPath', keyframeIds: ids, tolerance: 0.5 }]);
		expectValid(h);
		const res = r.results[0] as { properties: { maxError: number }[] };
		expect(res.properties[0]!.maxError).toBeLessThanOrEqual(0.5);
		const after = pos();
		// The drawn path stays within the tolerance in layer px (normalised units would allow half the box).
		for (let j = 0; j <= 400; j++) {
			const p = px(evaluate(after, t0 + ((t1 - t0) * j) / 400, { metric: M }));
			expect(distanceToPolyline(p, original)).toBeLessThan(0.5 + 1e-6);
		}
		// Linear timing on every segment of the span: constant speed in layer px, the last key arriving linearly too.
		const k = after.keyframes;
		for (let s = 0; s + 1 < k.length; s++) {
			expect(segmentShape(k as Keyframe<unknown>[], s, s + 1)).toBe('linear');
			const speeds: number[] = [];
			for (let f = 0; f < 30; f++) {
				const at = (g: number) => k[s]!.time + ((k[s + 1]!.time - k[s]!.time) * g) / 30;
				const p = px(evaluate(after, at(f), { metric: M }));
				const q = px(evaluate(after, at(f + 1), { metric: M }));
				speeds.push(Math.hypot(q[0] - p[0], q[1] - p[1]));
			}
			const mean = speeds.reduce((sum, v) => sum + v, 0) / speeds.length;
			for (const v of speeds) expect(Math.abs(v - mean) / mean).toBeLessThan(0.02);
		}
	});
});
